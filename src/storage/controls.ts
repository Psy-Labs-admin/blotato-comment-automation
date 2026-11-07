import type { PoolClient } from 'pg';
import { audit } from './audit';
import { enqueueOutbox } from './outbox';

/**
 * Persists the cancel decision (authoritative: every send checks it) and the command that wakes the
 * workflow, in one transaction. Returns false if cancel had already been requested.
 */
export async function requestRunCancel(
  c: PoolClient,
  o: { tenantId: string; runId: string; reason: string; now: Date },
): Promise<boolean> {
  const r = await c.query(
    `UPDATE run_controls SET cancel_requested = true, cancel_reason = $2, requested_at = $3
     WHERE run_id = $1 AND NOT cancel_requested`,
    [o.runId, o.reason, o.now],
  );
  if (!r.rowCount) return false;
  await enqueueOutbox(c, {
    tenantId: o.tenantId,
    kind: 'workflow.signal',
    idempotencyKey: `cancel:${o.runId}`,
    payload: { runId: o.runId, signal: 'cancelRequested', args: [{ reason: o.reason }] },
  });
  await audit(c, { tenantId: o.tenantId, runId: o.runId, type: 'run.cancel_requested', reason: o.reason });
  return true;
}
