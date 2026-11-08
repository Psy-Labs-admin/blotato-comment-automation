import type { RequestTrace, TraceRouteGroup, Tracing } from '../observability/tracing';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { onIntentSettled } from '../activities/runs';
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
import { localRequest } from './loopback';
import { bearerDigest, validWebhook, type ApiAccess } from './access';
import { registerConsole } from '../ui';
import { buildConversationTimeline, buildTimeline } from '../timeline';

export interface ServerDeps {
  access?: ApiAccess;
  demo?: boolean;
  tracing?: Tracing;
  db: Pool;
  clock: Clock;
  onOutbox?: () => void;
  metrics?: Metrics;
  logger?: boolean;
}

const Uuid = z.string().uuid();

/**
 * Thin HTTP layer: webhook intake from the existing integration, and management/inspection for the
 * product. A verified operator token selects the tenant. Local demos use x-tenant-id. Every
 * query is scoped by it, so another tenant's ids simply do not exist (404).
 */
export function buildServer(deps: ServerDeps): FastifyInstance {
  const { db, clock } = deps;
  const metrics = deps.metrics ?? createMetrics(db);
  const app = Fastify({
    logger: deps.logger === false ? false : { level: process.env.LOG_LEVEL ?? 'info', redact: ['req.headers.authorization'] },
  });

  const tracing = deps.tracing;
  if (tracing?.enabled) {
    const spans = new WeakMap<FastifyRequest, RequestTrace>();
    function finish(req: FastifyRequest, status: number) {
      const route = req.routeOptions.url;
      const group: TraceRouteGroup = !route ? 'unmatched'
        : route === '/webhooks/instagram' ? 'webhook'
        : route === '/health' ? 'health' : route === '/metrics' ? 'metrics'
        : route === '/' || route.startsWith('/console') ? 'console' : 'management';
      spans.get(req)?.end(status, group);
      spans.delete(req);
    }
    app.addHook('onRequest', (req, _reply, done) => {
      const span = tracing.startRequest(req.method);
      spans.set(req, span);
      span.run(done);
    });
    app.addHook('onResponse', async (req, reply) => finish(req, reply.statusCode));
    app.addHook('onRequestAbort', async (req) => finish(req, 499));
    app.addHook('onTimeout', async (req) => finish(req, 504));
  }
  if (!deps.access) {
    app.addHook('onRequest', async (req, reply) => {
      if (!localRequest(req.headers.host, req.headers.origin)) return reply.code(403).send({ error: 'Local requests only' });
    });
  }
  if (deps.demo && !deps.access) {
    app.get('/demo/workspace', async (_req, reply) => {
      const connection = await db.query("SELECT tenant_id FROM social_connections WHERE platform = 'instagram' AND external_account_id = 'ig_demo_coffee'");
      return connection.rowCount ? { tenantId: connection.rows[0].tenant_id } : reply.code(404).send({ error: 'Demo has not been seeded' });
    });
  }
  registerConsole(app);
  app.get('/', async (_req, reply) => reply.redirect('/console'));

  function tenantOf(req: FastifyRequest, reply: FastifyReply): string | undefined {
    if (deps.access) {
      const tenant = deps.access.tenants.get(bearerDigest(req.headers.authorization) ?? '');
      if (!tenant || (req.headers['x-tenant-id'] && req.headers['x-tenant-id'] !== tenant)) {
        reply.code(401).send({ error: 'A valid tenant access token is required' });
        return undefined;
      }
      return tenant;
    }
    const t = Uuid.safeParse(req.headers['x-tenant-id']);
    if (!t.success) {
      reply.code(401).send({ error: 'x-tenant-id header (uuid) required' });
      return undefined;
    }
    return t.data;
  }
  const idParam = (req: FastifyRequest) => Uuid.safeParse((req.params as any).id);

  app.addHook('onSend', async (_req, reply) => {
    reply.header('cache-control', 'no-store');
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
  });
  app.get('/health', async (_req, reply) => {
    try {
      await db.query('SELECT 1');
      return { ok: true };
    } catch {
      return reply.code(503).send({ ok: false });
    }
  });

  app.get('/metrics', async (req, reply) => {
    if (deps.access && bearerDigest(req.headers.authorization) !== deps.access.metricsDigest) {
      return reply.code(401).send({ error: 'A monitoring token is required' });
    }
    reply.header('content-type', metrics.registry.contentType);
    return metrics.registry.metrics();
  });

  // ---- Webhook intake ---------------------------------------------------------------------------
  app.register(async (hooks) => {
    hooks.addContentTypeParser('application/json', { parseAs: 'buffer', bodyLimit: 65536 }, (_req, bytes, done) => done(null, bytes));
    hooks.post('/webhooks/instagram', async (req, reply) => {
      if (!Buffer.isBuffer(req.body)) return reply.code(415).send({ error: 'application/json required' });
      if (deps.access && !validWebhook(req.body, req.headers['x-webhook-timestamp'], req.headers['x-webhook-signature'], deps.access.webhookSecret, clock.now())) {
        return reply.code(401).send({ error: 'Invalid webhook signature or timestamp' });
      }
      let event;
      try {
        event = JSON.parse(req.body.toString('utf8'));
      } catch {
        return reply.code(400).send({ error: 'Invalid JSON' });
      }
      const type = ['comment.created', 'message.received'].includes(event?.type) ? event.type : 'unknown';
      const ingest = () => ingestEvent({ db, clock }, event);
      const res = await (tracing ? tracing.withSpan('webhook.ingest', ingest) : ingest());
      if (res.status === 'rejected') {
        metrics.webhooks.inc({ type, result: 'rejected' });
        return reply.code(res.httpStatus).send({ error: res.reason });
      }
      metrics.webhooks.inc({ type, result: res.duplicate ? 'duplicate' : 'accepted' });
      if (!res.duplicate) {
        const route = () => routeEvent({ db, clock, onOutbox: deps.onOutbox }, res.eventId);
        await (tracing ? tracing.withSpan('webhook.route', route) : route()).catch((err) => req.log.error({ err, eventId: res.eventId }, 'inline routing failed'));
      }
      return reply.code(202).send({ eventId: res.eventId, duplicate: res.duplicate });
    });
  });

  /** "What happened to this webhook?" — routing outcome and the run it started or touched. */
  app.get('/events/:id', async (req, reply) => {
    const tenantId = tenantOf(req, reply);
    const id = idParam(req);
    if (!tenantId) return;
    const ev = id.success
      ? (
          await db.query(
            `SELECT id, event_type, conversation_id, seq, received_at, routing_status, routing_outcome, run_id
               FROM inbox_events WHERE id = $1 AND tenant_id = $2`,
            [id.data, tenantId],
          )
        ).rows[0]
      : undefined;
    if (!ev) return reply.code(404).send({ error: 'not found' });
    return {
      id: ev.id, eventType: ev.event_type, conversationId: ev.conversation_id, seq: Number(ev.seq), receivedAt: ev.received_at,
      routingStatus: ev.routing_status, routingOutcome: ev.routing_outcome, runId: ev.run_id,
    };
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
    const filter = z.object({
      status: z.enum(['starting', 'running', 'waiting_input', 'blocked_unknown', 'completed', 'cancelled', 'failed', 'expired']).optional(),
      needsReview: z.enum(['true', 'false']).optional(), cursor: Uuid.optional(),
    }).safeParse(req.query);
    if (!filter.success) return reply.code(400).send({ error: 'Invalid run filters or cursor' });
    const { status, needsReview, cursor } = filter.data;
    const r = await db.query(
      `SELECT r.id, r.automation_id, r.status, r.status_reason, r.current_step, r.created_at, r.finished_at, a.name AS automation_name, c.participant_id
        FROM automation_runs r JOIN automations a ON a.id = r.automation_id JOIN conversations c ON c.id = r.conversation_id
        WHERE r.tenant_id = $1 AND ($2::text IS NULL OR r.status = $2)
          AND (NOT $3::boolean OR EXISTS (SELECT 1 FROM message_intents i WHERE i.run_id = r.id AND i.status = 'unknown'))
          AND ($4::uuid IS NULL OR (r.created_at, r.id) < (SELECT created_at, id FROM automation_runs WHERE tenant_id = $1 AND id = $4))
        ORDER BY r.created_at DESC, r.id DESC LIMIT 201`,
      [tenantId, status ?? null, needsReview === 'true', cursor ?? null],
    );
    const runs = r.rows.slice(0, 200);
    return { runs, nextCursor: r.rows.length > 200 ? runs[199].id : null };
  });

  app.get('/runs/:id', async (req, reply) => {
    const tenantId = tenantOf(req, reply);
    const id = idParam(req);
    if (!tenantId) return;
    if (!id.success) return reply.code(404).send({ error: 'not found' });
    const run = (await db.query(`SELECT r.*, a.name AS automation_name, c.participant_id FROM automation_runs r
      JOIN automations a ON a.id = r.automation_id JOIN conversations c ON c.id = r.conversation_id
      WHERE r.id = $1 AND r.tenant_id = $2`, [id.data, tenantId])).rows[0];
    if (!run) return reply.code(404).send({ error: 'not found' });
    const [intents, waits, lead, metadata] = await Promise.all([
      db.query(`SELECT id, step_id, action_no, kind, status, status_reason, attempt_count, provider_message_id, resolved_by FROM message_intents WHERE run_id = $1 ORDER BY created_at`, [run.id]),
      db.query(`SELECT id, step_id, status, deadline, clarifications_used FROM input_waits WHERE run_id = $1`, [run.id]),
      db.query(`SELECT id, email, email_status, crm_status FROM leads WHERE run_id = $1`, [run.id]),
      db.query(
        `SELECT e.media_id, m.status, m.metadata, m.fetched_at, m.expires_at
         FROM inbox_events e LEFT JOIN post_metadata_cache m ON m.connection_id = e.connection_id
         AND m.media_id = e.media_id AND m.tenant_id = e.tenant_id WHERE e.id = $1 AND e.tenant_id = $2`,
        [run.trigger_event_id, tenantId],
      ),
    ]);
    return { run, intents: intents.rows, waits: waits.rows, lead: lead.rows[0] ?? null, postMetadata: metadata.rows[0] ?? null };
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
      await c.query(
        `SELECT 1 FROM conversations WHERE id = (SELECT conversation_id FROM automation_runs WHERE id = $1 AND tenant_id = $2) FOR UPDATE`,
        [id.data, tenantId],
      );
      const run = (await c.query(`SELECT finished_at FROM automation_runs WHERE id = $1 AND tenant_id = $2`, [id.data, tenantId])).rows[0];
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
    if (!id.success) return reply.code(404).send({ error: 'not found' });
    const r = await withTx(db, async (c) => {
      const changed = await c.query(
          `UPDATE social_connections SET sends_paused = false, sends_paused_reason = NULL, status = 'active' WHERE id = $1 AND tenant_id = $2`,
          [id.data, tenantId],
        );
      if (changed.rowCount) await resolveIncident(c, { tenantId, connectionId: id.data, errorClass: 'connection_unauthorized' });
      return changed;
    });
    if (r.rowCount) deps.onOutbox?.();
    return r.rowCount ? { sendsPaused: false } : reply.code(404).send({ error: 'not found' });
  });

  // ---- Operator resolution of uncertain sends -------------------------------------------------------
  const Resolve = z.object({ resolution: z.enum(['accepted', 'not_sent']), note: z.string().trim().min(1).max(500) });

  app.post('/intents/:id/resolve', async (req, reply) => {
    const tenantId = tenantOf(req, reply);
    const id = idParam(req);
    if (!tenantId) return;
    if (!id.success) return reply.code(404).send({ error: 'not found' });
    const body = Resolve.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'resolution (accepted|not_sent) and note are required' });

    const result = await withTx(db, async (c) => {
      // Lock order as everywhere else: conversation, then intent. Taking the conversation lock first
      // serialises this decision with a concurrent finalizeRun, so the run is either still active
      // (we wake it) or already finished (we release its conversation) — never neither.
      const head = (await c.query(`SELECT conversation_id FROM message_intents WHERE id = $1 AND tenant_id = $2`, [id.data, tenantId])).rows[0];
      if (!head) return 404;
      await c.query(`SELECT 1 FROM conversations WHERE id = $1 FOR UPDATE`, [head.conversation_id]);
      const intent = (await c.query(`SELECT * FROM message_intents WHERE id = $1 FOR UPDATE`, [id.data])).rows[0];
      if (intent.status !== 'unknown') return 409;
      const run = (await c.query(`SELECT finished_at FROM automation_runs WHERE id = $1`, [intent.run_id])).rows[0];
      if (body.data.resolution === 'accepted') {
        await c.query(`UPDATE message_intents SET status = 'accepted', status_reason = NULL, resolved_by = 'operator', updated_at = now() WHERE id = $1`, [intent.id]);
      } else if (run.finished_at) {
        // Not sent, and the run is over: nothing will retry it.
        await c.query(`UPDATE message_intents SET status = 'cancelled', status_reason = 'operator_not_sent', resolved_by = 'operator', updated_at = now() WHERE id = $1`, [intent.id]);
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
      await onIntentSettled(c, { intentId: intent.id, runId: intent.run_id, tenantId }, clock.now(), `operator:${intent.attempt_count}`);
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
    const filter = z.object({ since: z.string().datetime({ offset: true }).optional() }).safeParse(req.query);
    if (!filter.success) return reply.code(400).send({ error: 'since must be an ISO 8601 timestamp with a timezone' });
    const since = filter.data.since ? new Date(filter.data.since) : new Date(0);
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
           (SELECT count(DISTINCT i.run_id)::int FROM message_intents i JOIN runs r ON r.id = i.run_id
              WHERE i.kind = 'dm' AND i.wait_id IS NULL AND i.action_no = 1 AND i.status = 'accepted'
                AND i.body ~* 'https?://[^[:space:]]+') AS links_accepted,
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
      linksAccepted: f.links_accepted,
      runsCompleted: f.runs_completed,
      crmSynced: f.crm_synced,
      sendsUnknown: f.sends_unknown,
      suppressed: Object.fromEntries(suppressed.rows.map((r) => [r.reason, r.n])),
      runsByStatus: Object.fromEntries(outcomes.rows.map((r) => [r.status, r.n])),
    };
  });

  return app;
}
