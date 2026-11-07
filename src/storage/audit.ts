import type { PoolClient } from 'pg';

export interface AuditEntry {
  tenantId: string;
  type: string;
  runId?: string | null;
  conversationId?: string | null;
  eventId?: string | null;
  intentId?: string | null;
  reason?: string | null;
  /** References and decisions only — never message bodies or email addresses. */
  data?: Record<string, unknown>;
}

/** Append-only decision log, written in the same transaction as the decision it explains. */
export async function audit(c: PoolClient, e: AuditEntry): Promise<void> {
  await c.query(
    `INSERT INTO run_audit_events (tenant_id, run_id, conversation_id, inbox_event_id, intent_id, type, reason, data)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [e.tenantId, e.runId ?? null, e.conversationId ?? null, e.eventId ?? null, e.intentId ?? null, e.type, e.reason ?? null, e.data ?? {}],
  );
}
