import type { PoolClient } from 'pg';
import { raiseIncident } from '../alerts/incidents';
import { Reason } from '../domain/reasons';
import type { RunOutcome, RunStatus } from '../domain/types';
import { audit } from '../storage/audit';
import { withTx } from '../storage/db';
import { enqueueOutbox } from '../storage/outbox';
import type { ActivityDeps } from './deps';

type StoreDeps = Pick<ActivityDeps, 'db' | 'clock'>;

/** Status projection for people (timeline, dashboards). Never read to decide the next step. */
export async function setRunStatus(deps: StoreDeps, i: { runId: string; status: RunStatus; reason?: string }): Promise<void> {
  await withTx(deps.db, async (c) => {
    const r = await c.query(
      `UPDATE automation_runs SET status = $2, status_reason = $3, updated_at = now() WHERE id = $1 AND finished_at IS NULL RETURNING tenant_id, conversation_id`,
      [i.runId, i.status, i.reason ?? null],
    );
    if (r.rowCount) {
      await audit(c, { tenantId: r.rows[0].tenant_id, runId: i.runId, conversationId: r.rows[0].conversation_id, type: 'run.status', reason: i.reason, data: { status: i.status } });
    }
  });
}

/**
 * Ends a run. A send still `in_flight` at this point will never be recorded by this run, so it
 * becomes `unknown` (visible, alerted). Conversation ownership is released only when none of the
 * run's sends is unresolved: an uncertain DM keeps the conversation held, so no other automation
 * can start talking to the person until we know what they actually received.
 */
export async function finalizeRun(deps: StoreDeps, i: { runId: string; outcome: RunOutcome; reason?: string }): Promise<{ conversationReleased: boolean }> {
  return withTx(deps.db, async (c) => {
    const run = (await c.query(`SELECT * FROM automation_runs WHERE id = $1`, [i.runId])).rows[0];
    if (!run) throw new Error(`run ${i.runId} not found`);
    const conv = (await c.query(`SELECT * FROM conversations WHERE id = $1 FOR UPDATE`, [run.conversation_id])).rows[0];
    if (run.finished_at) return { conversationReleased: conv.owner_run_id !== i.runId };

    const now = deps.clock.now();
    const lost = await c.query(
      `UPDATE message_intents SET status = 'unknown', status_reason = $2, updated_at = now()
        WHERE run_id = $1 AND status = 'in_flight' RETURNING id, connection_id, step_id`,
      [i.runId, Reason.ATTEMPT_OUTCOME_LOST],
    );
    for (const intent of lost.rows) {
      await audit(c, { tenantId: run.tenant_id, runId: i.runId, conversationId: conv.id, intentId: intent.id, type: 'send.unknown', reason: Reason.ATTEMPT_OUTCOME_LOST, data: { stepId: intent.step_id } });
      await raiseIncident(c, { tenantId: run.tenant_id, connectionId: intent.connection_id, errorClass: 'send_outcome_unknown', runId: i.runId });
    }
    await c.query(`UPDATE automation_runs SET status = $2, status_reason = $3, finished_at = $4, updated_at = now() WHERE id = $1`, [
      i.runId, i.outcome, i.reason ?? null, now,
    ]);
    await c.query(`UPDATE input_waits SET status = 'cancelled', closed_at = $2 WHERE run_id = $1 AND status IN ('prepared', 'active')`, [i.runId, now]);
    await audit(c, { tenantId: run.tenant_id, runId: i.runId, conversationId: conv.id, type: 'run.finished', reason: i.reason ?? i.outcome, data: { outcome: i.outcome } });
    return { conversationReleased: await releaseIfSettled(c, i.runId, now) };
  });
}

/**
 * Releases the conversation if the run is finished and has no unresolved sends. The cooldown
 * starts only if the run actually reached the person (at least one accepted send); a run that
 * failed before sending anything must not suppress the next trigger.
 */
export async function releaseIfSettled(c: PoolClient, runId: string, now: Date): Promise<boolean> {
  const run = (await c.query(`SELECT tenant_id, conversation_id, finished_at FROM automation_runs WHERE id = $1`, [runId])).rows[0];
  const conv = (await c.query(`SELECT owner_run_id FROM conversations WHERE id = $1 FOR UPDATE`, [run.conversation_id])).rows[0];
  if (conv.owner_run_id !== runId) return true;
  if (!run.finished_at) return false;
  const counts = (
    await c.query(
      `SELECT count(*) FILTER (WHERE status IN ('in_flight', 'unknown'))::int AS unresolved,
              count(*) FILTER (WHERE status = 'accepted')::int AS accepted
         FROM message_intents WHERE run_id = $1`,
      [runId],
    )
  ).rows[0];
  if (counts.unresolved > 0) {
    await audit(c, { tenantId: run.tenant_id, runId, conversationId: run.conversation_id, type: 'conversation.held', reason: 'unresolved_send', data: { unresolved: counts.unresolved } });
    return false;
  }
  await c.query(
    `UPDATE conversations SET owner_run_id = NULL, last_run_finished_at = CASE WHEN $3 THEN $2 ELSE last_run_finished_at END WHERE id = $1`,
    [run.conversation_id, now, counts.accepted > 0],
  );
  await audit(c, { tenantId: run.tenant_id, runId, conversationId: run.conversation_id, type: 'conversation.released' });
  return true;
}

/**
 * An unknown send just got settled (late result, operator decision). Caller holds the
 * conversation lock. A finished run may now release its conversation; an active run is woken so
 * it re-reads the ledger instead of waiting for its periodic re-check.
 */
export async function onIntentSettled(
  c: PoolClient,
  i: { intentId: string; runId: string; tenantId: string },
  now: Date,
  keySuffix: string,
): Promise<void> {
  const run = (await c.query(`SELECT finished_at FROM automation_runs WHERE id = $1`, [i.runId])).rows[0];
  if (run.finished_at) {
    await releaseIfSettled(c, i.runId, now);
    return;
  }
  await enqueueOutbox(c, {
    tenantId: i.tenantId,
    kind: 'workflow.signal',
    idempotencyKey: `resolved:${i.intentId}:${keySuffix}`,
    payload: { runId: i.runId, signal: 'intentResolved', args: [{ intentId: i.intentId }] },
  });
}
