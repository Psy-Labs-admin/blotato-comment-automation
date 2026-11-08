import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import type { Clock } from '../domain/clock';
import { withTx } from '../storage/db';
import { InstagramCredentialError, saveInstagramAccount } from './accounts';
import { INSTAGRAM_SCOPES, type InstagramConfig } from './config';

const callbackPath = '/integrations/instagram/callback';
const cookieName = 'blotato_instagram_oauth';
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const nonce = () => randomBytes(32).toString('hex');
const randomValue = /^[a-f0-9]{64}$/;

interface LoginDeps {
  db: Pool;
  clock: Clock;
  config?: InstagramConfig;
  tenantOf(req: FastifyRequest, reply: FastifyReply): string | undefined;
  sessionIdentity(req: FastifyRequest): { sessionHash: string; credentialHash: string } | undefined;
  credentialActive(credentialHash: string, tenantId: string): boolean;
  fetch?: typeof fetch;
}

class InstagramLoginError extends Error {
  constructor() { super('Instagram authorization could not be completed.'); }
}

async function metaJson(request: typeof fetch, url: string | URL, init: RequestInit = {}): Promise<any> {
  const response = await request(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(10_000) });
  const body: any = await response.json().catch(() => undefined);
  if (!response.ok || !body || body.error) throw new InstagramLoginError();
  return body;
}

function readBinding(req: FastifyRequest): string | undefined {
  const values = (req.headers.cookie ?? '').split(';').map((part) => part.trim()).filter((part) => part.startsWith(cookieName + '='));
  if (values.length !== 1) return undefined;
  const value = values[0].slice(cookieName.length + 1);
  return randomValue.test(value) ? value : undefined;
}

function bindingCookie(config: InstagramConfig, value: string, seconds: number): string {
  return `${cookieName}=${value}; Path=${callbackPath}; Max-Age=${seconds}; HttpOnly; SameSite=Lax${config.redirectUri.startsWith('https://') ? '; Secure' : ''}`;
}

function tokenResponse(body: any): { token: string; scopes: string[] } {
  const result = Array.isArray(body?.data) && body.data.length === 1 ? body.data[0] : body;
  const rawScopes = result?.permissions;
  const scopes = typeof rawScopes === 'string' ? rawScopes.split(',').map((scope) => scope.trim())
    : Array.isArray(rawScopes) && rawScopes.every((scope) => typeof scope === 'string') ? rawScopes : [];
  if (typeof result?.access_token !== 'string' || !result.access_token || result.access_token.length > 8192 || INSTAGRAM_SCOPES.some((scope) => !scopes.includes(scope))) {
    throw new InstagramLoginError();
  }
  return { token: result.access_token, scopes };
}

/** Business Login for Instagram. Meta's code/token endpoints are fixed and never supplied by a browser. */
export function registerInstagramLogin(app: FastifyInstance, deps: LoginDeps): void {
  app.post('/integrations/instagram/connect', async (req, reply) => {
    const tenantId = deps.tenantOf(req, reply);
    if (!tenantId) return;
    const config = deps.config;
    if (!config) return reply.code(503).send({ error: 'Configure Instagram Login before connecting an account.', code: 'instagram_unconfigured' });
    const session = deps.sessionIdentity(req);
    if (!session) return reply.code(401).send({ error: 'Sign in through the browser before connecting Instagram.' });
    const input = z.object({ connectionId: z.string().uuid().optional() }).strict().safeParse(req.body ?? {});
    if (!input.success) return reply.code(400).send({ error: 'Choose a valid Instagram account.' });
    let expectedAccountId: string | null = null;
    if (input.data.connectionId) {
      const account = (await deps.db.query('SELECT external_account_id FROM social_connections WHERE id = $1 AND tenant_id = $2', [input.data.connectionId, tenantId])).rows[0];
      if (!account) return reply.code(404).send({ error: 'Account not found.' });
      expectedAccountId = account.external_account_id;
    }
    const state = nonce();
    const binding = nonce();
    const expiresAt = new Date(deps.clock.now().getTime() + 10 * 60_000);
    const stored = await withTx(deps.db, async (c) => {
      const valid = await c.query(`SELECT 1 FROM operator_sessions WHERE session_hash = $1 AND tenant_id = $2 AND credential_hash = $3 AND expires_at > now() FOR SHARE`,
        [session.sessionHash, tenantId, session.credentialHash]);
      if (!valid.rowCount) return false;
      await c.query('DELETE FROM instagram_login_states WHERE session_hash = $1', [session.sessionHash]);
      await c.query(`INSERT INTO instagram_login_states
        (state_hash, binding_hash, session_hash, credential_hash, tenant_id, expected_account_id, expires_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [digest(state), digest(binding), session.sessionHash, session.credentialHash, tenantId, expectedAccountId, expiresAt]);
      return true;
    });
    if (!stored) return reply.code(401).send({ error: 'Your session expired. Sign in again.' });
    reply.header('set-cookie', bindingCookie(config, binding, 600));
    const url = new URL('https://www.instagram.com/oauth/authorize');
    url.searchParams.set('client_id', config.appId);
    url.searchParams.set('redirect_uri', config.redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', INSTAGRAM_SCOPES.join(','));
    url.searchParams.set('state', state);
    url.searchParams.set('enable_fb_login', '0');
    url.searchParams.set('force_authentication', '1');
    return { url: url.toString() };
  });

  app.post('/integrations/instagram/accounts/:id/disconnect', async (req, reply) => {
    const tenantId = deps.tenantOf(req, reply);
    if (!tenantId) return;
    if (!deps.sessionIdentity(req)) return reply.code(401).send({ error: 'Sign in through the browser before disconnecting Instagram.' });
    const id = z.string().uuid().safeParse((req.params as { id?: string }).id);
    if (!id.success) return reply.code(404).send({ error: 'Account not found.' });
    const disconnected = await withTx(deps.db, async (c) => {
      const account = (await c.query('SELECT integration_kind FROM social_connections WHERE id = $1 AND tenant_id = $2 FOR NO KEY UPDATE', [id.data, tenantId])).rows[0];
      if (!account || account.integration_kind !== 'native') return false;
      // Keep the generation counter after erasing the secret so a late response cannot match a future connection.
      await c.query(`UPDATE instagram_credentials SET encrypted_token = '', expires_at = now(), refresh_after = 'infinity',
        token_version = token_version + 1, refresh_claim = NULL, refreshing_until = NULL, updated_at = now()
        WHERE connection_id = $1 AND tenant_id = $2`, [id.data, tenantId]);
      await c.query("UPDATE social_connections SET status = 'disconnected', verified_at = NULL, sends_paused = true, sends_paused_reason = 'operator_disconnected' WHERE id = $1", [id.data]);
      // A consent already in progress must not restore a connection after the operator removed it.
      await c.query('DELETE FROM instagram_login_states WHERE tenant_id = $1', [tenantId]);
      return true;
    });
    return disconnected ? { disconnected: true } : reply.code(404).send({ error: 'Account not found.' });
  });

  app.get(callbackPath, async (req, reply) => {
    const config = deps.config;
    if (!config) return reply.redirect('/console?instagram=unconfigured#accounts');
    const query = z.object({ state: z.string().regex(randomValue), code: z.string().min(1).max(4096).optional(), error: z.string().max(200).optional() }).safeParse(req.query);
    const binding = readBinding(req);
    reply.header('set-cookie', bindingCookie(config, '', 0));
    if (!query.success || !binding) return reply.redirect('/console?instagram=expired#accounts');
    const state = (await deps.db.query(`UPDATE instagram_login_states l SET consumed_at = $3
      FROM operator_sessions s WHERE l.state_hash = $1 AND l.binding_hash = $2 AND l.consumed_at IS NULL
        AND l.expires_at > $3 AND s.session_hash = l.session_hash AND s.tenant_id = l.tenant_id
        AND s.credential_hash = l.credential_hash AND s.expires_at > $3
      RETURNING l.tenant_id, l.session_hash, l.credential_hash, l.expected_account_id`,
      [digest(query.data.state), digest(binding), deps.clock.now()])).rows[0];
    if (!state || !deps.credentialActive(state.credential_hash, state.tenant_id)) return reply.redirect('/console?instagram=expired#accounts');
    if (query.data.error || !query.data.code) return reply.redirect('/console?instagram=denied#accounts');
    const request = deps.fetch ?? fetch;
    try {
      const form = new URLSearchParams({ client_id: config.appId, client_secret: config.appSecret,
        grant_type: 'authorization_code', redirect_uri: config.redirectUri, code: query.data.code });
      const short = tokenResponse(await metaJson(request, 'https://api.instagram.com/oauth/access_token', {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form.toString(),
      }));
      const exchange = new URL('https://graph.instagram.com/access_token');
      exchange.searchParams.set('grant_type', 'ig_exchange_token');
      exchange.searchParams.set('client_secret', config.appSecret);
      exchange.searchParams.set('access_token', short.token);
      const long = await metaJson(request, exchange);
      if (typeof long.access_token !== 'string' || !long.access_token || long.access_token.length > 8192 || !Number.isSafeInteger(long.expires_in) || long.expires_in <= 86_400 || long.expires_in > 366 * 86_400) throw new InstagramLoginError();
      const profileUrl = new URL(`https://graph.instagram.com/${config.graphVersion}/me`);
      profileUrl.searchParams.set('fields', 'user_id,username');
      const profile = await metaJson(request, profileUrl, { headers: { authorization: 'Bearer ' + long.access_token } });
      const own = z.object({ user_id: z.string().regex(/^\d+$/), username: z.string().min(1).max(100) }).safeParse(profile);
      if (!own.success || (state.expected_account_id && state.expected_account_id !== own.data.user_id)) throw new InstagramLoginError();
      const existing = (await deps.db.query("SELECT tenant_id FROM social_connections WHERE platform = 'instagram' AND external_account_id = $1", [own.data.user_id])).rows[0];
      if (existing && existing.tenant_id !== state.tenant_id) throw new InstagramLoginError();
      const subscribed = await metaJson(request, `https://graph.instagram.com/${config.graphVersion}/me/subscribed_apps`, {
        method: 'POST', headers: { authorization: 'Bearer ' + long.access_token, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ subscribed_fields: 'comments,messages' }).toString(),
      });
      if (subscribed.success !== true) throw new InstagramLoginError();
      await saveInstagramAccount({ db: deps.db, config, clock: deps.clock, credentialActive: deps.credentialActive }, {
        tenantId: state.tenant_id, sessionHash: state.session_hash, credentialHash: state.credential_hash,
        accountId: own.data.user_id, username: own.data.username, expectedAccountId: state.expected_account_id,
        loginStateHash: digest(query.data.state), token: long.access_token, expiresIn: long.expires_in, grantedScopes: short.scopes,
      });
      return reply.redirect('/console#accounts');
    } catch (error) {
      if (!(error instanceof InstagramLoginError) && !(error instanceof InstagramCredentialError)) {
        req.log.warn({ event: 'instagram_login_failed' }, 'Instagram authorization failed');
      }
      return reply.redirect('/console?instagram=failed#accounts');
    }
  });
}
