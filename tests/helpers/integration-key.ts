import { createHash, randomBytes } from 'node:crypto';
import type { Pool } from 'pg';

/** Test-only fixture; production issuance uses the audited operator CLI. */
export async function createIntegrationKey(
  db: Pool,
  tenantId: string,
  name: string,
  scope: 'read' | 'write' = 'read',
) {
  const token = 'blt_' + randomBytes(32).toString('base64url');
  const result = await db.query<{ id: string }>(
    'INSERT INTO integration_keys(tenant_id,name,scope,token_hash) VALUES($1,$2,$3,$4) RETURNING id',
    [tenantId, name, scope, createHash('sha256').update(token).digest('hex')],
  );
  return { id: result.rows[0].id, token };
}
