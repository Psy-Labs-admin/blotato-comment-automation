import type { PoolClient } from 'pg';
import type { RunOutcome, RunStatus } from '../domain/types';
import { audit } from '../storage/audit';
import { withTx } from '../storage/db';
import type { ActivityDeps } from './deps';

/** Status projection for people (timeline, dashboards). Never read to decide the next step. */
export async function setRunStatus(deps: ActivityDeps, i: { runId: string; status: RunStatus; reason?: string }): Promise<void> {
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
 * Ends a run. Conversation ownership is released only when none of the run's sends is in an
 * unresolved state: an uncertain DM keeps the conversation held, so no other automation can start
 * talking to the person until we know what they actually received.
 */
export async function finalizeRun(deps: ActivityDeps, i: { runId: string; outcome: RunOutcome; reason?: string }): Promise<{ conversationReleased: boolean }> {
  return withTx(deps.db, async (c) => {
    const run = (await c.query(`SELECT * FROM automation_runs WHERE id = $1`, [i.runId])).rows[0];
    if (!run) throw new Error(`run ${i.runId} not found`);
    const conv = (await c.query(`SELECT * FROM conversations WHERE id = $1 FOR UPDATE`, [run.conversation_id])).rows[0];
    if (run.finished_at) return { conversationReleased: conv.owner_run_id !== i.runId };

    const now = deps.clock.now();
    await c.query(`UPDATE automation_runs SET status = $2, status_reason = $3, finished_at = $4, updated_at = now() WHERE id = $1`, [
      i.runId, i.outcome, i.reason ?? null, now,
    ]);
    await c.query(`UPDATE input_waits SET status = 'cancelled', closed_at = $2 WHERE run_id = $1 AND status IN ('prepared', 'active')`, [i.runId, now]);
    await audit(c, { tenantId: run.tenant_id, runId: i.runId, conversationId: conv.id, type: 'run.finished', reason: i.reason ?? i.outcome, data: { outcome: i.outcome } });
    return { conversationReleased: await releaseIfSettled(c, i.runId, now) };
  });
}

/**
 * Releases the conversation if the run is finished and has no unresolved sends. Also called when an
 * operator or reconciliation resolves the last unknown intent of a finished run.
 */
export async function releaseIfSettled(c: PoolClient, runId: string, now: Date): Promise<boolean> {
  const run = (await c.query(`SELECT tenant_id, conversation_id, finished_at FROM automation_runs WHERE id = $1`, [runId])).rows[0];
  const conv = (await c.query(`SELECT owner_run_id FROM conversations WHERE id = $1 FOR UPDATE`, [run.conversation_id])).rows[0];
  if (conv.owner_run_id !== runId) return true;
  if (!run.finished_at) return false;
  const unresolved = (
    await c.query(`SELECT count(*)::int AS n FROM message_intents WHERE run_id = $1 AND status IN ('in_flight', 'unknown')`, [runId])
  ).rows[0].n;
  if (unresolved > 0) {
    await audit(c, { tenantId: run.tenant_id, runId, conversationId: run.conversation_id, type: 'conversation.held', reason: 'unresolved_send', data: { unresolved } });
    return false;
  }
  await c.query(`UPDATE conversations SET owner_run_id = NULL, last_run_finished_at = $2 WHERE id = $1`, [run.conversation_id, now]);
  await audit(c, { tenantId: run.tenant_id, runId, conversationId: run.conversation_id, type: 'conversation.released' });
  return true;
}
