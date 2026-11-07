import { WorkflowNotFoundError, type Client } from '@temporalio/client';
import type { Pool } from 'pg';
import { finalizeRun } from '../activities/runs';
import type { Clock } from '../domain/clock';
import { Reason } from '../domain/reasons';

/**
 * Last line of defence for "never stuck silently": a run whose workflow no longer runs
 * (terminated by an operator, history limit, namespace retention, a bug that failed the workflow)
 * but which was never finalized is finalized here as `failed: workflow_closed`. Sends left
 * `in_flight` become `unknown` (incident), so the conversation is released or visibly held.
 *
 * Runs in the relay role on an interval. Cost: one describe() per unfinished run older than
 * `olderThanMs`, bounded by `limit` per pass (oldest first).
 */
export async function reconcileOrphans(o: { db: Pool; client: Client; clock: Clock; olderThanMs?: number; limit?: number }): Promise<number> {
  const candidates = await o.db.query(
    `SELECT id, workflow_id FROM automation_runs
      WHERE finished_at IS NULL AND status <> 'starting' AND updated_at <= now() - make_interval(secs => $1)
      ORDER BY updated_at LIMIT $2`,
    [(o.olderThanMs ?? 5 * 60_000) / 1000, o.limit ?? 100],
  );
  let finalized = 0;
  for (const run of candidates.rows) {
    let closed: boolean;
    try {
      const d = await o.client.workflow.getHandle(run.workflow_id).describe();
      closed = d.status.name !== 'RUNNING';
    } catch (err) {
      if (!(err instanceof WorkflowNotFoundError)) throw err;
      closed = true;
    }
    if (!closed) continue;
    await finalizeRun({ db: o.db, clock: o.clock }, { runId: run.id, outcome: 'failed', reason: Reason.WORKFLOW_CLOSED });
    finalized += 1;
  }
  return finalized;
}
