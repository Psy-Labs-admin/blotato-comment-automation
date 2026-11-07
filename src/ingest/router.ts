import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { Clock } from '../domain/clock';
import type { AutomationDefinition } from '../domain/definition';
import { matchesKeyword } from '../domain/matching';
import { Reason } from '../domain/reasons';
import { audit } from '../storage/audit';
import { withTx } from '../storage/db';
import { enqueueOutbox } from '../storage/outbox';

export interface RouteOutcome {
  eventId: string;
  outcome: string;
  runId: string | null;
  alreadyRouted: boolean;
}

export interface RouterDeps {
  db: Pool;
  clock: Clock;
  /** Called after commit when outbox rows were written (lets the relay pick them up immediately). */
  onOutbox?: () => void;
}

export function workflowIdFor(runId: string): string {
  return `comment-automation-${runId}`;
}

/**
 * Step 2 of the pipeline: decide what a stored event means. Idempotent: the decision is taken
 * under the conversation lock and recorded on the inbox row, so the inline call and the sweeper
 * can both try without double effects.
 */
export async function routeEvent(deps: RouterDeps, eventId: string): Promise<RouteOutcome> {
  let wroteOutbox = false;
  const result = await withTx(deps.db, async (c) => {
    const head = await c.query(`SELECT conversation_id FROM inbox_events WHERE id = $1`, [eventId]);
    if (!head.rowCount) throw new Error(`inbox event ${eventId} not found`);
    const conv = (await c.query(`SELECT * FROM conversations WHERE id = $1 FOR UPDATE`, [head.rows[0].conversation_id])).rows[0];
    const ev = (await c.query(`SELECT * FROM inbox_events WHERE id = $1`, [eventId])).rows[0];
    if (ev.routing_status === 'routed') {
      return { eventId, outcome: ev.routing_outcome, runId: ev.run_id, alreadyRouted: true };
    }
    const decision = ev.event_type === 'comment.created' ? await routeComment(c, ev, conv, deps.clock.now()) : await routeMessage(c, ev, conv);
    wroteOutbox = decision.outbox;
    await c.query(`UPDATE inbox_events SET routing_status = 'routed', routing_outcome = $2, run_id = $3 WHERE id = $1`, [
      eventId,
      decision.outcome,
      decision.runId,
    ]);
    return { eventId, outcome: decision.outcome, runId: decision.runId, alreadyRouted: false };
  });
  if (wroteOutbox) deps.onOutbox?.();
  return result;
}

/** Sweeper: routes events whose inline routing never happened (crash between ack and route). */
export async function routePending(deps: RouterDeps, limit = 100): Promise<number> {
  const pending = await deps.db.query(
    `SELECT id FROM inbox_events WHERE routing_status = 'pending' ORDER BY received_at LIMIT $1`,
    [limit],
  );
  for (const row of pending.rows) await routeEvent(deps, row.id);
  return pending.rowCount ?? 0;
}

interface Decision {
  outcome: string;
  runId: string | null;
  outbox: boolean;
}

async function routeComment(c: PoolClient, ev: any, conv: any, now: Date): Promise<Decision> {
  const candidates = await c.query(
    `SELECT a.id, a.priority, a.cooldown_seconds, v.id AS version_id, v.version, v.definition
       FROM automations a JOIN automation_versions v ON v.id = a.active_version_id
      WHERE a.tenant_id = $1 AND a.connection_id = $2 AND a.status = 'active'
      ORDER BY a.priority DESC, a.id ASC`,
    [ev.tenant_id, ev.connection_id],
  );
  const matching = candidates.rows.filter((a) => {
    const def = a.definition as AutomationDefinition;
    if (def.trigger.type !== 'comment.created' || !matchesKeyword(ev.text, def.trigger.keyword)) return false;
    return def.trigger.posts === 'all_supported' || def.trigger.posts.mediaIds.includes(ev.media_id);
  });
  if (!matching.length) return { outcome: Reason.NO_MATCH, runId: null, outbox: false };

  const [winner, ...losers] = matching;
  for (const loser of losers) {
    await audit(c, {
      tenantId: ev.tenant_id, conversationId: conv.id, eventId: ev.id, type: 'automation.not_selected',
      reason: Reason.LOWER_PRIORITY, data: { automationId: loser.id, winnerAutomationId: winner.id },
    });
  }

  const conn = (await c.query(`SELECT status FROM social_connections WHERE id = $1`, [ev.connection_id])).rows[0];
  const suppression =
    conn.status !== 'active' ? Reason.CONNECTION_INACTIVE
    : conv.opted_out ? Reason.OPTED_OUT
    : conv.human_takeover ? Reason.HUMAN_TAKEOVER
    : conv.owner_run_id ? Reason.CONVERSATION_BUSY
    : conv.last_run_finished_at && now.getTime() - new Date(conv.last_run_finished_at).getTime() < winner.cooldown_seconds * 1000
      ? Reason.COOLDOWN
    : null;
  if (suppression) {
    await audit(c, {
      tenantId: ev.tenant_id, conversationId: conv.id, eventId: ev.id, type: 'trigger.suppressed', reason: suppression,
      data: { automationId: winner.id, ownerRunId: conv.owner_run_id ?? undefined },
    });
    return { outcome: suppression, runId: null, outbox: false };
  }

  const runId = randomUUID();
  await c.query(
    `INSERT INTO automation_runs (id, tenant_id, automation_id, version_id, conversation_id, trigger_event_id, workflow_id, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'starting')`,
    [runId, ev.tenant_id, winner.id, winner.version_id, conv.id, ev.id, workflowIdFor(runId)],
  );
  await c.query(`INSERT INTO run_controls (run_id) VALUES ($1)`, [runId]);
  await c.query(`UPDATE conversations SET owner_run_id = $2 WHERE id = $1`, [conv.id, runId]);
  await enqueueOutbox(c, { tenantId: ev.tenant_id, kind: 'workflow.start', idempotencyKey: `start:${runId}`, payload: { runId } });
  await audit(c, {
    tenantId: ev.tenant_id, runId, conversationId: conv.id, eventId: ev.id, type: 'run.created', reason: Reason.STARTED,
    data: { automationId: winner.id, version: winner.version, mediaId: ev.media_id, commentId: ev.comment_id },
  });
  return { outcome: Reason.STARTED, runId, outbox: true };
}

async function routeMessage(c: PoolClient, ev: any, conv: any): Promise<Decision> {
  if (!conv.owner_run_id) return { outcome: Reason.NO_ACTIVE_RUN, runId: null, outbox: false };
  const runId: string = conv.owner_run_id;
  const wait = (
    await c.query(
      `SELECT id, boundary_seq FROM input_waits WHERE run_id = $1 AND status IN ('prepared', 'active') LIMIT 1`,
      [runId],
    )
  ).rows[0];
  if (!wait) return { outcome: Reason.NO_ACTIVE_WAIT, runId, outbox: false };
  if (wait.boundary_seq === null || Number(ev.seq) <= Number(wait.boundary_seq)) {
    return { outcome: Reason.BEFORE_PROMPT, runId, outbox: false };
  }
  // The signal is only a wake-up: the workflow re-reads the inbox under the lock to decide.
  await enqueueOutbox(c, {
    tenantId: ev.tenant_id, kind: 'workflow.signal', idempotencyKey: `signal:${ev.id}`,
    payload: { runId, signal: 'inboxChanged' },
  });
  return { outcome: Reason.INPUT_PENDING, runId, outbox: true };
}
