import type { PoolClient } from 'pg';

export type OutboxKind = 'workflow.start' | 'workflow.signal' | 'crm.lead_captured' | 'alert.notify';

export type WorkflowSignalName = 'inboxChanged' | 'cancelRequested' | 'intentResolved';

export interface WorkflowStartPayload {
  runId: string;
}
export interface WorkflowSignalPayload {
  runId: string;
  signal: WorkflowSignalName;
  args?: unknown[];
}
export interface LeadCapturedPayload {
  leadId: string;
}
export interface AlertNotifyPayload {
  incidentId: string;
  kind: 'opened' | 'update' | 'resolved';
}

/**
 * Written in the same transaction as the state change that requires it, so a command or business
 * event can never be lost between "our DB committed" and "the other system was told".
 * The idempotency key makes re-enqueueing (activity retry, duplicate webhook) a no-op.
 */
export async function enqueueOutbox(
  c: PoolClient,
  m: { tenantId: string | null; kind: OutboxKind; idempotencyKey: string; payload: object; availableAt?: Date },
): Promise<boolean> {
  const r = await c.query(
    `INSERT INTO outbox (tenant_id, kind, idempotency_key, payload, next_attempt_at)
     VALUES ($1, $2, $3, $4, coalesce($5, now()))
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [m.tenantId, m.kind, m.idempotencyKey, m.payload, m.availableAt ?? null],
  );
  return (r.rowCount ?? 0) > 0;
}
