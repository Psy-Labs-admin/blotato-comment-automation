import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { Clock } from '../domain/clock';
import { systemClock } from '../domain/clock';
import { withTx } from '../storage/db';
import { raiseIncident, resolveIncident } from '../alerts/incidents';
import type { InstagramConfig } from './config';

export class InstagramCredentialError extends Error {
  constructor(public readonly code: 'reconnect_required' | 'credentials_unavailable') {
    super(code === 'reconnect_required' ? 'Reconnect this Instagram account.' : 'Instagram credentials are temporarily unavailable.');
  }
}

export function encryptInstagramToken(token: string, key: Buffer, tenantId: string, connectionId: string): string {
  if (key.length !== 32) throw new Error('Instagram encryption key must contain 32 bytes');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(tenantId + ':' + connectionId));
  const body = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), body.toString('base64url')].join('.');
}

export function decryptInstagramToken(encrypted: string, key: Buffer, tenantId: string, connectionId: string): string {
  try {
    const [version, iv, tag, body, extra] = encrypted.split('.');
    if (version !== 'v1' || !iv || !tag || !body || extra || key.length !== 32) throw new Error();
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
    decipher.setAAD(Buffer.from(tenantId + ':' + connectionId));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8');
  } catch { throw new InstagramCredentialError('credentials_unavailable'); }
}

type TokenOptions = { db: Pool; encryptionKey: Buffer; clock?: Clock; graphBaseUrl?: string; fetch?: typeof fetch };
export type InstagramCredentials = { token: string; accountId: string; connectionId: string; tenantId: string; tokenVersion: number };

function refreshDate(now: Date, expiresIn: number): Date {
  return new Date(now.getTime() + Math.max(25 * 3_600_000, Math.min(30 * 86_400_000, expiresIn * 500)));
}

/** Called only after Meta has returned the authenticated account and accepted its subscriptions. */
export async function saveInstagramAccount(o: { db: Pool; config: InstagramConfig; clock?: Clock; credentialActive: (hash: string, tenantId: string) => boolean }, input: {
  tenantId: string; sessionHash: string; credentialHash: string; accountId: string; username: string;
  token: string; expiresIn: number; grantedScopes: string[]; loginStateHash: string; expectedAccountId?: string | null;
}): Promise<string> {
  const clock = o.clock ?? systemClock;
  return withTx(o.db, async (c) => {
    if (!o.credentialActive(input.credentialHash, input.tenantId)) throw new InstagramCredentialError('reconnect_required');
    const session = (await c.query(`SELECT tenant_id, credential_hash FROM operator_sessions
      WHERE session_hash = $1 AND expires_at > now() FOR SHARE`, [input.sessionHash])).rows[0];
    if (!session || session.tenant_id !== input.tenantId || session.credential_hash !== input.credentialHash) throw new InstagramCredentialError('reconnect_required');
    if (input.expectedAccountId && input.expectedAccountId !== input.accountId) throw new InstagramCredentialError('reconnect_required');
    await c.query(`INSERT INTO social_connections (tenant_id, platform, external_account_id, status) VALUES ($1, 'instagram', $2, 'disconnected')
      ON CONFLICT (platform, external_account_id) DO NOTHING`, [input.tenantId, input.accountId]);
    const account = (await c.query("SELECT id, tenant_id FROM social_connections WHERE platform = 'instagram' AND external_account_id = $1 FOR NO KEY UPDATE", [input.accountId])).rows[0];
    if (account.tenant_id !== input.tenantId) throw new InstagramCredentialError('reconnect_required');
    const login = await c.query('SELECT 1 FROM instagram_login_states WHERE state_hash = $1 AND session_hash = $2 AND tenant_id = $3 AND consumed_at IS NOT NULL AND expires_at > now() FOR SHARE', [input.loginStateHash, input.sessionHash, input.tenantId]);
    if (!login.rowCount) throw new InstagramCredentialError('reconnect_required');
    const now = clock.now();
    const expiresAt = new Date(now.getTime() + input.expiresIn * 1000);
    await c.query(`INSERT INTO instagram_credentials
      (connection_id, tenant_id, encrypted_token, expires_at, refresh_after, granted_scopes)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (connection_id) DO UPDATE SET encrypted_token = excluded.encrypted_token,
        expires_at = excluded.expires_at, refresh_after = excluded.refresh_after, granted_scopes = excluded.granted_scopes,
        token_version = instagram_credentials.token_version + 1, refresh_claim = NULL, refreshing_until = NULL, updated_at = now()`,
      [account.id, input.tenantId, encryptInstagramToken(input.token, o.config.encryptionKey, input.tenantId, account.id), expiresAt,
        refreshDate(now, input.expiresIn), input.grantedScopes]);
    await c.query(`UPDATE social_connections SET display_name = $2, status = 'active', integration_kind = 'native', verified_at = $3,
      capabilities = $4, integration_revision = integration_revision + 1, integration_updated_at = $3,
      sends_paused = CASE WHEN sends_paused_reason IN ('provider_unauthorized', 'operator_disconnected') THEN false ELSE sends_paused END,
      sends_paused_reason = CASE WHEN sends_paused_reason IN ('provider_unauthorized', 'operator_disconnected') THEN NULL ELSE sends_paused_reason END WHERE id = $1`,
      [account.id, input.username, now, o.config.capabilities]);
    await resolveIncident(c, { tenantId: input.tenantId, connectionId: account.id, errorClass: 'connection_unauthorized' });
    if (!o.credentialActive(input.credentialHash, input.tenantId)) throw new InstagramCredentialError('reconnect_required');
    return account.id;
  });
}

async function requireReconnect(db: Pool, row: any, refreshClaim?: string): Promise<boolean> {
  return withTx(db, async (c) => {
    await c.query('SELECT id FROM social_connections WHERE id = $1 FOR NO KEY UPDATE', [row.connection_id]);
    const invalidated = await c.query(`UPDATE instagram_credentials SET expires_at = now(), refresh_claim = NULL, refreshing_until = NULL
      WHERE connection_id = $1 AND token_version = $2 AND ($3::uuid IS NULL OR refresh_claim = $3) RETURNING tenant_id`, [row.connection_id, row.token_version, refreshClaim ?? null]);
    if (!invalidated.rowCount) return false;
    await c.query(`UPDATE social_connections SET status = 'unauthorized', verified_at = NULL,
      sends_paused = true, sends_paused_reason = 'provider_unauthorized' WHERE id = $1`, [row.connection_id]);
    await raiseIncident(c, { tenantId: row.tenant_id, connectionId: row.connection_id, errorClass: 'connection_unauthorized' });
    return true;
  });
}

async function refreshAccount(o: TokenOptions, connectionId: string): Promise<boolean> {
  const now = (o.clock ?? systemClock).now();
  const claim = randomUUID();
  const row = (await o.db.query(`UPDATE instagram_credentials i SET refresh_claim = $2, refreshing_until = $3
    FROM social_connections sc WHERE i.connection_id = $1 AND sc.id = i.connection_id
      AND sc.status = 'active' AND sc.verified_at IS NOT NULL AND i.expires_at > $4 AND i.refresh_after <= $4
      AND (i.refreshing_until IS NULL OR i.refreshing_until <= $4)
    RETURNING i.*, sc.external_account_id`, [connectionId, claim, new Date(now.getTime() + 30_000), now])).rows[0];
  if (!row) return false;
  let failedAuthentication = false;
  try {
    const token = decryptInstagramToken(row.encrypted_token, o.encryptionKey, row.tenant_id, row.connection_id);
    const url = new URL('/refresh_access_token', o.graphBaseUrl ?? 'https://graph.instagram.com');
    url.searchParams.set('grant_type', 'ig_refresh_token');
    const response = await (o.fetch ?? fetch)(url, {
      headers: { authorization: 'Bearer ' + token }, redirect: 'error', signal: AbortSignal.timeout(10_000),
    });
    const body: any = await response.json().catch(() => undefined);
    failedAuthentication = response.status === 401 || [190, 102].includes(Number(body?.error?.code));
    if (failedAuthentication) throw new InstagramCredentialError('reconnect_required');
    if (!response.ok || typeof body?.access_token !== 'string' || !body.access_token || !Number.isSafeInteger(body.expires_in) || body.expires_in <= 86_400 || body.expires_in > 366 * 86_400) {
      throw new InstagramCredentialError('credentials_unavailable');
    }
    const refreshedAt = (o.clock ?? systemClock).now();
    const updated = await o.db.query(`UPDATE instagram_credentials SET encrypted_token = $3, expires_at = $4, refresh_after = $5,
      token_version = token_version + 1, refresh_claim = NULL, refreshing_until = NULL, updated_at = now()
      WHERE connection_id = $1 AND refresh_claim = $2 AND token_version = $6 RETURNING connection_id`,
      [row.connection_id, claim, encryptInstagramToken(body.access_token, o.encryptionKey, row.tenant_id, row.connection_id),
        new Date(refreshedAt.getTime() + body.expires_in * 1000), refreshDate(refreshedAt, body.expires_in), row.token_version]);
    return !!updated.rowCount;
  } catch {
    if (failedAuthentication) {
      if (await requireReconnect(o.db, row, claim)) throw new InstagramCredentialError('reconnect_required');
      return false;
    }
    await o.db.query(`UPDATE instagram_credentials SET refresh_claim = NULL, refreshing_until = NULL, refresh_after = $3
      WHERE connection_id = $1 AND refresh_claim = $2`, [row.connection_id, claim, new Date(now.getTime() + 15 * 60_000)]);
    return false;
  }
}

export async function getInstagramCredentials(o: TokenOptions, externalAccountId: string): Promise<InstagramCredentials> {
  const read = async () => (await o.db.query(`SELECT i.*, sc.external_account_id, sc.status, sc.verified_at
    FROM instagram_credentials i JOIN social_connections sc ON sc.id = i.connection_id
    WHERE sc.platform = 'instagram' AND sc.external_account_id = $1`, [externalAccountId])).rows[0];
  let row = await read();
  if (!row || row.status !== 'active' || !row.verified_at) throw new InstagramCredentialError('reconnect_required');
  const now = (o.clock ?? systemClock).now();
  if (row.expires_at <= now) {
    await requireReconnect(o.db, row);
    row = await read();
    if (!row || row.status !== 'active' || !row.verified_at || row.expires_at <= now) throw new InstagramCredentialError('reconnect_required');
  }
  if (row.refresh_after <= now) {
    await refreshAccount(o, row.connection_id);
    row = await read();
    if (!row || row.status !== 'active' || !row.verified_at || row.expires_at <= (o.clock ?? systemClock).now()) throw new InstagramCredentialError('reconnect_required');
  }
  return { token: decryptInstagramToken(row.encrypted_token, o.encryptionKey, row.tenant_id, row.connection_id),
    accountId: row.external_account_id, connectionId: row.connection_id, tenantId: row.tenant_id, tokenVersion: row.token_version };
}

export async function refreshInstagramCredentials(o: { db: Pool; config: InstagramConfig; clock?: Clock; graphBaseUrl?: string; fetch?: typeof fetch }, connectionId: string): Promise<boolean> {
  return refreshAccount({ ...o, encryptionKey: o.config.encryptionKey }, connectionId);
}

export async function refreshDueInstagramAccounts(o: { db: Pool; config: InstagramConfig; clock?: Clock }, limit = 25): Promise<number> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid Instagram refresh batch size');
  const now = (o.clock ?? systemClock).now();
  const rows = await o.db.query(`SELECT i.* FROM instagram_credentials i JOIN social_connections sc ON sc.id = i.connection_id
    WHERE i.refresh_after <= $1 AND sc.status = 'active' AND sc.verified_at IS NOT NULL
    ORDER BY i.refresh_after LIMIT $2`, [now, limit]);
  let refreshed = 0;
  for (const row of rows.rows) {
    if (row.expires_at <= now) await requireReconnect(o.db, row);
    else if (await refreshInstagramCredentials(o, row.connection_id)) refreshed += 1;
  }
  return refreshed;
}

export const refreshDueInstagramCredentials = refreshDueInstagramAccounts;
