import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { releaseIfSettled } from '../activities/runs';
import { resolveIncident, settleUnknownIncident } from '../alerts/incidents';
import type { Clock } from '../domain/clock';
import { DefinitionError } from '../domain/definition';
import { Reason } from '../domain/reasons';
import { ingestEvent } from '../ingest/ingest';
import { routeEvent } from '../ingest/router';
import { createMetrics, type Metrics } from '../observability/metrics';
import { createAutomation, publishVersion, setAutomationStatus } from '../storage/admin';
import { audit } from '../storage/audit';
import { requestRunCancel } from '../storage/controls';
import { withTx } from '../storage/db';
import { enqueueOutbox } from '../storage/outbox';
import { buildConversationTimeline, buildTimeline } from '../timeline';

export interface ServerDeps {
  db: Pool;
  clock: Clock;
  onOutbox?: () => void;
  metrics?: Metrics;
  logger?: boolean;
}

const Uuid = z.string().uuid();

/**
 * Thin HTTP layer: webhook intake from the existing integration, and management/inspection for the
 * product. Tenant context comes from `x-tenant-id` (stand-in for the product's real auth); every
 * query is scoped by it, so another tenant's ids simply do not exist (404).
 */
export function buildServer(deps: ServerDeps): FastifyInstance {
  const { db, clock } = deps;
  const metrics = deps.metrics ?? createMetrics(db);
  const app = Fastify({
    logger: deps.logger === false ? false : { level: process.env.LOG_LEVEL ?? 'info', redact: ['req.headers.authorization'] },
  });

  function tenantOf(req: FastifyRequest, reply: FastifyReply): string | undefined {
    const t = Uuid.safeParse(req.headers['x-tenant-id']);
    if (!t.success) {
      reply.code(401).send({ error: 'x-tenant-id header (uuid) required' });
      return undefined;
    }
    return t.data;
  }
  const idParam = (req: FastifyRequest) => Uuid.safeParse((req.params as any).id);

  app.get('/health', async () => {
    await db.query('SELECT 1');
    return { ok: true };
  });

  app.get('/metrics', async (_req, reply) => {
    reply.header('content-type', metrics.registry.contentType);
    return metrics.registry.metrics();
  });

  // ---- Webhook intake ---------------------------------------------------------------------------
  app.post('/webhooks/instagram', async (req, reply) => {
    const res = await ingestEvent({ db, clock }, req.body);
    const type = String((req.body as any)?.type ?? 'unknown').slice(0, 40);
    if (res.status === 'rejected') {
      metrics.webhooks.inc({ type, result: 'rejected' });
      return reply.code(res.httpStatus).send({ error: res.reason });
    }
    metrics.webhooks.inc({ type, result: res.duplicate ? 'duplicate' : 'accepted' });
    // The event is durable now. Routing is attempted inline for latency; if it fails, the sweeper
    // routes it later, and the acknowledgement is unaffected.
    if (!res.duplicate) {
      await routeEvent({ db, clock, onOutbox: deps.onOutbox }, res.eventId).catch((err) => req.log.error({ err, eventId: res.eventId }, 'inline routing failed'));
    }
    return reply.code(202).send({ eventId: res.eventId, duplicate: res.duplicate });
  });

  // ---- Automations ------------------------------------------------------------------------------
  const CreateAutomation = z.object({
    connectionId: Uuid,
    name: z.string().min(1).max(200),
    definition: z.unknown(),
    priority: z.number().int().min(-1000).max(1000).optional(),
    cooldownSeconds: z.number().int().min(0).max(30 * 86400).optional(),
  });

  app.post('/automations', async (req, reply) => {
    const tenantId = tenantOf(req, reply);
    if (!tenantId) return;
    const body = CreateAutomation.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid body', issues: body.error.issues.map((i) => i.message) });
    const conn = await db.query(`SELECT 1 FROM social_connections WHERE id = $1 AND tenant_id = $2`, [body.data.connectionId, tenantId]);
    if (!conn.rowCount) return reply.code(404).send({ error: 'connection not found' });
    try {
      const created = await createAutomation(db, { tenantId, ...body.data, definition: body.data.definition });
      return reply.code(201).send(created);
    } catch (err) {
      if (err instanceof DefinitionError) return reply.code(400).send({ error: 'invalid definition', issues: err.issues });
      throw err;
    }
  });

  app.post('/automations/:id/versions', async (req, reply) => {
    const tenantId = tenantOf(req, reply);
    const id = idParam(req);
    if (!tenantId) return;
    if (!id.success) return reply.code(404).send({ error: 'not found' });
    try {
      const v = await publishVersion(db, { tenantId, automationId: id.data, definition: (req.body as any)?.definition });
      return v ? reply.code(201).send(v) : reply.code(404).send({ error: 'not found' });
    } catch (err) {
      if (err instanceof DefinitionError) return reply.code(400).send({ error: 'invalid definition', issues: err.issues });
      throw err;
    }
  });

  for (const [path, status] of [['disable', 'disabled'], ['enable', 'active']] as const) {
    app.post(`/automations/:id/${path}`, async (req, reply) => {
      const tenantId = tenantOf(req, reply);
      const id = idParam(req);
      if (!tenantId) return;
      if (!id.success || !(await setAutomationStatus(db, { tenantId, automationId: id.data, status }))) {
        return reply.code(404).send({ error: 'not found' });
      }
      return { status };
    });
  }

  app.get('/automations/:id', async (req, reply) => {
    const tenantId = tenantOf(req, reply);
    const id = idParam(req);
    if (!tenantId) return;
    if (!id.success) return reply.code(404).send({ error: 'not found' });
    const a = (await db.query(`SELECT * FROM automations WHERE id = $1 AND tenant_id = $2`, [id.data, tenantId])).rows[0];
    if (!a) return reply.code(404).send({ error: 'not found' });
    const versions = await db.query(`SELECT id, version, created_at FROM automation_versions WHERE automation_id = $1 ORDER BY version`, [a.id]);
    return { ...a, versions: versions.rows };
  });

  // ---- Runs -------------------------------------------------------------------------------------
  app.get('/runs', async (req, reply) => {
    const tenantId = tenantOf(req, reply);
    if (!tenantId) return;
    const status = (req.query as any)?.status as string | undefined;
    const r = await db.query(
      `SELECT id, automation_id, status, status_reason, current_step, created_at, finished_at FROM automation_runs
        WHERE tenant_id = $1 AND ($2::text IS NULL OR status = $2) ORDER BY created_at DESC LIMIT 200`,
      [tenantId, status ?? null],
    );
    return { runs: r.rows };
  });

  app.get('/runs/:id', async (req, reply) => {
    const tenantId = tenantOf(req, reply);
    const id = idParam(req);
    if (!tenantId) return;
    if (!id.success) return reply.code(404).send({ error: 'not found' });
    const run = (await db.query(`SELECT * FROM automation_runs WHERE id = $1 AND tenant_id = $2`, [id.data, tenantId])).rows[0];
    if (!run) return reply.code(404).send({ error: 'not found' });
    const [intents, waits, lead] = await Promise.all([
      db.query(`SELECT id, step_id, action_no, kind, status, status_reason, attempt_count, provider_message_id, resolved_by FROM message_intents WHERE run_id = $1 ORDER BY created_at`, [run.id]),
      db.query(`SELECT id, step_id, status, deadline, clarifications_used FROM input_waits WHERE run_id = $1`, [run.id]),
      db.query(`SELECT id, email, email_status, crm_status FROM leads WHERE run_id = $1`, [run.id]),
    ]);
    return { run, intents: intents.rows, waits: waits.rows, lead: lead.rows[0] ?? null };
  });

  app.get('/runs/:id/timeline', async (req, reply) => {
    const tenantId = tenantOf(req, reply);
    const id = idParam(req);
    if (!tenantId) return;
    const entries = id.success ? await buildTimeline(db, tenantId, id.data) : null;
    return entries ? { entries } : reply.code(404).send({ error: 'not found' });
  });

  app.post('/runs/:id/cancel', async (req, reply) => {
    const tenantId = tenantOf(req, reply);
    const id = idParam(req);
    if (!tenantId) return;
    if (!id.success) return reply.code(404).send({ error: 'not found' });
    const reason = String((req.body as any)?.reason ?? 'operator').slice(0, 100);
    const result = await withTx(db, async (c) => {
      const run = (await c.query(`SELECT finished_at FROM automation_runs WHERE id = $1 AND tenant_id = $2 FOR UPDATE`, [id.data, tenantId])).rows[0];
      if (!run) return 404;
      if (run.finished_at) return 409;
      await requestRunCancel(c, { tenantId, runId: id.data, reason, now: clock.now() });
      return 202;
    });
    deps.onOutbox?.();
    if (result === 404) return reply.code(404).send({ error: 'not found' });
    if (result === 409) return reply.code(409).send({ error: 'run already finished' });
    // "Requested", not "stopped": an external send already in flight cannot be recalled.
    return reply.code(202).send({ status: 'cancel_requested' });
  });

  // ---- Conversations ------------------------------------------------------------------------------
  app.get('/conversations/:id/timeline', async (req, reply) => {
    const tenantId = tenantOf(req, reply);
    const id = idParam(req);
    if (!tenantId) return;
    const t = id.success ? await buildConversationTimeline(db, tenantId, id.data) : null;
    return t ?? reply.code(404).send({ error: 'not found' });
  });

  for (const action of ['opt-out', 'takeover', 'release-takeover'] as const) {
    app.post(`/conversations/:id/${action}`, async (req, reply) => {
      const tenantId = tenantOf(req, reply);
      const id = idParam(req);
      if (!tenantId) return;
      if (!id.success) return reply.code(404).send({ error: 'not found' });
      const ok = await withTx(db, async (c) => {
        const conv = (await c.query(`SELECT * FROM conversations WHERE id = $1 AND tenant_id = $2 FOR UPDATE`, [id.data, tenantId])).rows[0];
        if (!conv) return false;
        if (action === 'release-takeover') {
          await c.query(`UPDATE conversations SET human_takeover = false WHERE id = $1`, [conv.id]);
        } else {
          const column = action === 'opt-out' ? 'opted_out' : 'human_takeover';
          await c.query(`UPDATE conversations SET ${column} = true WHERE id = $1`, [conv.id]);
          if (conv.owner_run_id) {
            await requestRunCancel(c, { tenantId, runId: conv.owner_run_id, reason: action === 'opt-out' ? Reason.OPTED_OUT : Reason.HUMAN_TAKEOVER, now: clock.now() });
          }
        }
        await audit(c, { tenantId, conversationId: conv.id, type: `conversation.${action}` });
        return true;
      });
      deps.onOutbox?.();
      return ok ? { ok: true } : reply.code(404).send({ error: 'not found' });
    });
  }

  // ---- Connections (account-level kill switch) ----------------------------------------------------
  app.post('/connections/:id/pause', async (req, reply) => {
    const tenantId = tenantOf(req, reply);
    const id = idParam(req);
    if (!tenantId) return;
    const reason = String((req.body as any)?.reason ?? 'operator').slice(0, 200);
    const r = id.success
      ? await db.query(`UPDATE social_connections SET sends_paused = true, sends_paused_reason = $3 WHERE id = $1 AND tenant_id = $2`, [id.data, tenantId, reason])
      : { rowCount: 0 };
    return r.rowCount ? { sendsPaused: true } : reply.code(404).send({ error: 'not found' });
  });

  app.post('/connections/:id/resume', async (req, reply) => {
    const tenantId = tenantOf(req, reply);
    const id = idParam(req);
    if (!tenantId) return;
    const r = id.success
      ? await db.query(
          `UPDATE social_connections SET sends_paused = false, sends_paused_reason = NULL, status = 'active' WHERE id = $1 AND tenant_id = $2`,
          [id.data, tenantId],
        )
      : { rowCount: 0 };
    if (r.rowCount && id.success) {
      await withTx(db, (c) => resolveIncident(c, { tenantId, connectionId: id.data, errorClass: 'connection_unauthorized' }));
      deps.onOutbox?.();
    }
    return r.rowCount ? { sendsPaused: false } : reply.code(404).send({ error: 'not found' });
  });

  // ---- Operator resolution of uncertain sends -------------------------------------------------------
  const Resolve = z.object({ resolution: z.enum(['accepted', 'not_sent']), note: z.string().min(1).max(500) });

  app.post('/intents/:id/resolve', async (req, reply) => {
    const tenantId = tenantOf(req, reply);
    const id = idParam(req);
    if (!tenantId) return;
    if (!id.success) return reply.code(404).send({ error: 'not found' });
    const body = Resolve.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'resolution (accepted|not_sent) and note are required' });

    const result = await withTx(db, async (c) => {
      const intent = (await c.query(`SELECT * FROM message_intents WHERE id = $1 AND tenant_id = $2 FOR UPDATE`, [id.data, tenantId])).rows[0];
      if (!intent) return 404;
      if (intent.status !== 'unknown') return 409;
      if (body.data.resolution === 'accepted') {
        await c.query(`UPDATE message_intents SET status = 'accepted', status_reason = NULL, resolved_by = 'operator', updated_at = now() WHERE id = $1`, [intent.id]);
      } else {
        // Operator confirmed it never reached the person: the same intent may be attempted again.
        await c.query(
          `UPDATE message_intents SET status = 'pending', status_reason = 'operator_not_sent', current_attempt_id = NULL, resolved_by = 'operator', updated_at = now() WHERE id = $1`,
          [intent.id],
        );
      }
      await audit(c, {
        tenantId, runId: intent.run_id, conversationId: intent.conversation_id, intentId: intent.id,
        type: 'send.resolved', reason: 'operator', data: { resolution: body.data.resolution, note: body.data.note },
      });
      const run = (await c.query(`SELECT finished_at FROM automation_runs WHERE id = $1`, [intent.run_id])).rows[0];
      if (run.finished_at) {
        if (body.data.resolution === 'not_sent') {
          await c.query(`UPDATE message_intents SET status = 'cancelled', status_reason = 'run_finished' WHERE id = $1`, [intent.id]);
        }
        await releaseIfSettled(c, intent.run_id, clock.now());
      } else {
        await enqueueOutbox(c, {
          tenantId, kind: 'workflow.signal', idempotencyKey: `resolved:${intent.id}:${intent.attempt_count}`,
          payload: { runId: intent.run_id, signal: 'intentResolved', args: [{ intentId: intent.id }] },
        });
      }
      await settleUnknownIncident(c, { tenantId, connectionId: intent.connection_id });
      return 200;
    });
    deps.onOutbox?.();
    if (result === 404) return reply.code(404).send({ error: 'not found' });
    if (result === 409) return reply.code(409).send({ error: 'intent is not in unknown state' });
    return { status: 'resolved', resolution: body.data.resolution };
  });

  // ---- Business funnel (run cohort, from facts in Postgres) ---------------------------------------
  app.get('/funnel', async (req, reply) => {
    const tenantId = tenantOf(req, reply);
    if (!tenantId) return;
    const since = (req.query as any)?.since ? new Date((req.query as any).since) : new Date(0);
    const f = (
      await db.query(
        `WITH runs AS (SELECT * FROM automation_runs WHERE tenant_id = $1 AND created_at >= $2)
         SELECT
           (SELECT count(*)::int FROM inbox_events WHERE tenant_id = $1 AND received_at >= $2 AND event_type = 'comment.created'
              AND routing_status = 'routed' AND routing_outcome NOT IN ('no_match', 'ignored_self')) AS matched_comments,
           (SELECT count(*)::int FROM runs) AS runs_started,
           (SELECT count(DISTINCT i.run_id)::int FROM message_intents i JOIN runs r ON r.id = i.run_id
              WHERE i.wait_id IS NOT NULL AND i.status = 'accepted') AS prompts_accepted,
           (SELECT count(*)::int FROM leads l JOIN runs r ON r.id = l.run_id) AS emails_captured,
           (SELECT count(*)::int FROM runs WHERE status = 'completed') AS runs_completed,
           (SELECT count(*)::int FROM leads l JOIN runs r ON r.id = l.run_id WHERE l.crm_status = 'synced') AS crm_synced,
           (SELECT count(*)::int FROM message_intents i JOIN runs r ON r.id = i.run_id WHERE i.status = 'unknown') AS sends_unknown`,
        [tenantId, since],
      )
    ).rows[0];
    const suppressed = await db.query(
      `SELECT routing_outcome AS reason, count(*)::int AS n FROM inbox_events
        WHERE tenant_id = $1 AND received_at >= $2 AND event_type = 'comment.created'
          AND routing_outcome NOT IN ('no_match', 'ignored_self', 'started') GROUP BY routing_outcome`,
      [tenantId, since],
    );
    const outcomes = await db.query(`SELECT status, count(*)::int AS n FROM automation_runs WHERE tenant_id = $1 AND created_at >= $2 GROUP BY status`, [tenantId, since]);
    return {
      matchedComments: f.matched_comments,
      runsStarted: f.runs_started,
      promptsAccepted: f.prompts_accepted,
      emailsCaptured: f.emails_captured,
      runsCompleted: f.runs_completed,
      crmSynced: f.crm_synced,
      sendsUnknown: f.sends_unknown,
      suppressed: Object.fromEntries(suppressed.rows.map((r) => [r.reason, r.n])),
      runsByStatus: Object.fromEntries(outcomes.rows.map((r) => [r.status, r.n])),
    };
  });

  return app;
}
