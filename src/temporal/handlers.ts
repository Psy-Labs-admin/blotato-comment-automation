import { WorkflowExecutionAlreadyStartedError, WorkflowNotFoundError, type Client } from '@temporalio/client';
import type { Pool } from 'pg';
import type { OutboxHandler } from '../relay/relay';
import type { WorkflowSignalPayload, WorkflowStartPayload } from '../storage/outbox';
import type { commentAutomation } from '../workflows';

/**
 * Outbox -> Temporal. There is no transaction spanning Postgres and Temporal, so commands are
 * written to the outbox with the state change and delivered here, idempotently:
 *  - start uses the fixed workflow id derived from run_id; "already started" means done;
 *  - a signal for a workflow that is not started yet is retried later (never dropped);
 *  - a signal for a finished run is dropped (there is nothing left to wake).
 */
export function temporalHandlers(o: { client: Client; db: Pool; taskQueue: string; recheckMs?: number }): {
  'workflow.start': OutboxHandler;
  'workflow.signal': OutboxHandler;
} {
  return {
    'workflow.start': async (row) => {
      const { runId } = row.payload as WorkflowStartPayload;
      const run = (
        await o.db.query(
          `SELECT r.workflow_id, v.definition FROM automation_runs r JOIN automation_versions v ON v.id = r.version_id WHERE r.id = $1`,
          [runId],
        )
      ).rows[0];
      if (!run) throw new Error(`run ${runId} not found`);
      try {
        await o.client.workflow.start<typeof commentAutomation>('commentAutomation', {
          taskQueue: o.taskQueue,
          workflowId: run.workflow_id,
          args: [{ runId, definition: run.definition, recheckMs: o.recheckMs }],
          workflowIdConflictPolicy: 'USE_EXISTING',
          workflowIdReusePolicy: 'REJECT_DUPLICATE',
        });
      } catch (err) {
        if (!(err instanceof WorkflowExecutionAlreadyStartedError)) throw err;
      }
      await o.db.query(`UPDATE automation_runs SET status = 'running', updated_at = now() WHERE id = $1 AND status = 'starting'`, [runId]);
    },

    'workflow.signal': async (row) => {
      const { runId, signal, args } = row.payload as WorkflowSignalPayload;
      const run = (await o.db.query(`SELECT workflow_id, status, finished_at FROM automation_runs WHERE id = $1`, [runId])).rows[0];
      if (!run) throw new Error(`run ${runId} not found`);
      try {
        await o.client.workflow.getHandle(run.workflow_id).signal(signal, ...((args ?? []) as []));
      } catch (err) {
        if (!(err instanceof WorkflowNotFoundError)) throw err;
        if (run.finished_at) return;
        return { retryInMs: 500, reason: 'workflow not started yet' };
      }
    },
  };
}
