import type { Pool } from 'pg';
import type { Capabilities } from '../../src/domain/types';

export const DEFAULT_CAPABILITIES: Capabilities = {
  privateReplyWindowHours: 7 * 24,
  messagingWindowHours: 24,
  sendsPerWindow: 200,
  budgetWindowSeconds: 3600,
  recipientHourlyLimit: 10,
  reconciliation: 'none',
};

export async function createConnection(
  db: Pool,
  o: { tenantId: string; accountId: string; capabilities?: Partial<Capabilities> },
): Promise<string> {
  const caps = { ...DEFAULT_CAPABILITIES, ...(o.capabilities ?? {}) };
  return (
    await db.query(
      `INSERT INTO social_connections (tenant_id, platform, external_account_id, capabilities)
       VALUES ($1, 'instagram', $2, $3) RETURNING id`,
      [o.tenantId, o.accountId, caps],
    )
  ).rows[0].id;
}
