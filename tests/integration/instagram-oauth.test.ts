import { randomBytes, randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { registerInstagramLogin } from '../../src/instagram/oauth';
import { INSTAGRAM_SCOPES, loadInstagramConfig, type InstagramConfig } from '../../src/instagram/config';
import { decryptInstagramToken, getInstagramCredentials, refreshInstagramCredentials } from '../../src/instagram/accounts';
import { createTestDb } from '../helpers/db';
import { createAutomation, createTenant } from '../../src/storage/admin';
import { DEFAULT_CAPABILITIES } from '../helpers/account';
import { commentEvent } from '../helpers/fixtures';
import { pricingDefinition } from '../helpers/definitions';
import { ingestEvent } from '../../src/ingest/ingest';
import { routeEvent } from '../../src/ingest/router';
import { executeSend } from '../../src/activities/send';
import { systemClock } from '../../src/domain/clock';

const key = randomBytes(32);
const config: InstagramConfig = {
  appId: '123456789012345', appSecret: 'instagram-product-app-secret', webhookAppSecret: 'meta-webhook-app-secret',
  redirectUri: 'https://operator.example/integrations/instagram/callback', encryptionKey: key, graphVersion: 'v24.0',
  webhookVerifyToken: 'webhook-verification-secret', capabilities: { ...DEFAULT_CAPABILITIES, reconciliation: 'none' },
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('native Instagram Login and token lifecycle', () => {
  let data: Awaited<ReturnType<typeof createTestDb>>;
  const apps: FastifyInstance[] = [];
  beforeAll(async () => { data = await createTestDb(); });
  afterAll(async () => { await Promise.all(apps.map((app) => app.close())); await data?.drop(); });

  async function setup(options: { tenantId?: string; accountId?: string; missingScope?: boolean; subscriptionFailure?: boolean } = {}) {
    const tenantId = options.tenantId ?? await createTenant(data.db, 'OAuth operator');
    const sessionHash = randomBytes(32).toString('hex');
    const credentialHash = randomBytes(32).toString('hex');
    await data.db.query('INSERT INTO operator_sessions (session_hash, credential_hash, tenant_id, csrf_token, expires_at) VALUES ($1, $2, $3, $4, now() + interval \'1 hour\')',
      [sessionHash, credentialHash, tenantId, randomBytes(32).toString('hex')]);
    const accountId = options.accountId ?? '1784' + String(Math.floor(Math.random() * 1e11)).padStart(11, '0');
    const longToken = 'isolated-long-token-' + randomUUID();
    const calls: Array<{ url: URL; init: RequestInit }> = [];
    const authorization = { active: true };
    const hooks: { beforeSubscription?: () => Promise<void> } = {};
    const meta: typeof fetch = async (input, init = {}) => {
      const url = new URL(String(input));
      calls.push({ url, init });
      expect(init.redirect).toBe('error');
      if (url.hostname === 'api.instagram.com' && url.pathname === '/oauth/access_token') {
        const body = new URLSearchParams(String(init.body));
        expect(body.get('client_secret')).toBe(config.appSecret);
        expect(body.get('redirect_uri')).toBe(config.redirectUri);
        return json({ data: [{ access_token: 'isolated-short-token', user_id: 'different-oauth-user-id', permissions: options.missingScope ? ['instagram_business_basic'] : INSTAGRAM_SCOPES }] });
      }
      if (url.hostname === 'graph.instagram.com' && url.pathname === '/access_token') {
        expect(url.searchParams.get('grant_type')).toBe('ig_exchange_token');
        return json({ access_token: longToken, expires_in: 5_184_000 });
      }
      expect((init.headers as Record<string, string>).authorization).toBe('Bearer ' + longToken);
      if (url.pathname === '/v24.0/me') return json({ id: 'different-app-scoped-id', user_id: accountId, username: 'connected_owner' });
      if (url.pathname === '/v24.0/me/subscribed_apps') {
        expect(new URLSearchParams(String(init.body)).get('subscribed_fields')).toBe('comments,messages');
        await hooks.beforeSubscription?.();
        return options.subscriptionFailure ? json({ error: { code: 10 } }, 403) : json({ success: true });
      }
      throw new Error('Unexpected Meta endpoint in isolated OAuth test');
    };
    const app = Fastify();
    registerInstagramLogin(app, { db: data.db, clock: systemClock, config, fetch: meta,
      credentialActive(hash, tenant) { return authorization.active && hash === credentialHash && tenant === tenantId; },
      tenantOf(req, reply) { if (req.headers['x-test-session'] === sessionHash) return tenantId; reply.code(401).send({ error: 'Sign in' }); return undefined; },
      sessionIdentity(req) { return req.headers['x-test-session'] === sessionHash ? { sessionHash, credentialHash } : undefined; },
    });
    apps.push(app);
    const start = async (connectionId?: string) => {
      const res = await app.inject({ method: 'POST', url: '/integrations/instagram/connect', headers: { 'x-test-session': sessionHash }, payload: connectionId ? { connectionId } : {} });
      expect(res.statusCode).toBe(200);
      const cookie = String(res.headers['set-cookie']).split(';')[0];
      return { res, cookie, state: new URL(res.json().url).searchParams.get('state')! };
    };
    const callback = (state: string, cookie?: string, error?: string) => app.inject({ url: '/integrations/instagram/callback?' + new URLSearchParams({ state, ...(error ? { error } : { code: 'single-use-code' }) }), headers: cookie ? { cookie } : {} });
    return { app, tenantId, accountId, sessionHash, credentialHash, longToken, calls, start, callback, authorization, hooks };
  }

  it('validates deployment credentials and leaves native Instagram disabled until configured', () => {
    expect(loadInstagramConfig({})).toBeUndefined();
    expect(() => loadInstagramConfig({ INSTAGRAM_APP_ID: '1234' })).toThrow();
    const env = { INSTAGRAM_APP_ID: config.appId, INSTAGRAM_APP_SECRET: config.appSecret, META_APP_SECRET: config.webhookAppSecret,
      INSTAGRAM_REDIRECT_URI: config.redirectUri, INSTAGRAM_TOKEN_ENCRYPTION_KEY: key.toString('base64'),
      INSTAGRAM_GRAPH_VERSION: config.graphVersion, INSTAGRAM_WEBHOOK_VERIFY_TOKEN: config.webhookVerifyToken,
      INSTAGRAM_CAPABILITIES_JSON: JSON.stringify(config.capabilities) };
    expect(loadInstagramConfig(env)?.encryptionKey).toEqual(key);
    expect(() => loadInstagramConfig({ ...env, INSTAGRAM_TOKEN_ENCRYPTION_KEY: 'not-a-key' })).toThrow();
    expect(() => loadInstagramConfig({ ...env, INSTAGRAM_REDIRECT_URI: 'https://foreign.example/other' })).toThrow();
    expect(() => loadInstagramConfig({ ...env, INSTAGRAM_CAPABILITIES_JSON: JSON.stringify({ ...config.capabilities, reconciliation: 'lookup_by_client_ref' }) })).toThrow();
  });

  it('completes real protocol steps, binds the account to the initiating session and encrypts the token', async () => {
    const ctx = await setup();
    const start = await ctx.start();
    expect(new URL(start.res.json().url).origin).toBe('https://www.instagram.com');
    expect(new URL(start.res.json().url).searchParams.get('scope')).toBe(INSTAGRAM_SCOPES.join(','));
    expect(start.res.headers['set-cookie']).toMatch(/HttpOnly; SameSite=Lax; Secure/);
    const state = (await data.db.query('SELECT * FROM instagram_login_states WHERE session_hash = $1', [ctx.sessionHash])).rows[0];
    expect(JSON.stringify(state)).not.toContain(start.state);
    const callback = await ctx.callback(start.state, start.cookie);
    expect(callback.statusCode).toBe(302);
    expect(callback.headers.location).toBe('/console#accounts');
    const account = (await data.db.query('SELECT * FROM social_connections WHERE tenant_id = $1', [ctx.tenantId])).rows[0];
    expect(account.external_account_id).toBe(ctx.accountId);
    expect(account.display_name).toBe('connected_owner');
    expect(account.verified_at).toBeInstanceOf(Date);
    const credential = (await data.db.query('SELECT * FROM instagram_credentials WHERE connection_id = $1', [account.id])).rows[0];
    expect(JSON.stringify(credential)).not.toContain(ctx.longToken);
    expect(decryptInstagramToken(credential.encrypted_token, key, ctx.tenantId, account.id)).toBe(ctx.longToken);
    expect(() => decryptInstagramToken(credential.encrypted_token, key, randomUUID(), account.id)).toThrow();
    expect((await getInstagramCredentials({ db: data.db, encryptionKey: key }, ctx.accountId)).token).toBe(ctx.longToken);
    expect(ctx.calls).toHaveLength(4);
    expect((await ctx.callback(start.state, start.cookie)).headers.location).toContain('instagram=expired');
    expect(ctx.calls).toHaveLength(4);
  });

  it('rejects wrong browser binding, expired state and a revoked operator session before external calls', async () => {
    const ctx = await setup();
    const wrong = await ctx.start();
    expect((await ctx.callback(wrong.state, 'blotato_instagram_oauth=' + randomBytes(32).toString('hex'))).headers.location).toContain('instagram=expired');
    expect(ctx.calls).toHaveLength(0);
    const expired = await ctx.start();
    await data.db.query('UPDATE instagram_login_states SET expires_at = now() - interval \'1 second\' WHERE session_hash = $1', [ctx.sessionHash]);
    expect((await ctx.callback(expired.state, expired.cookie)).headers.location).toContain('instagram=expired');
    const revoked = await ctx.start();
    await data.db.query('DELETE FROM operator_sessions WHERE session_hash = $1', [ctx.sessionHash]);
    expect((await ctx.callback(revoked.state, revoked.cookie)).headers.location).toContain('instagram=expired');
    expect(ctx.calls).toHaveLength(0);
    expect((await data.db.query('SELECT id FROM social_connections WHERE tenant_id = $1', [ctx.tenantId])).rowCount).toBe(0);
  });

  it('rejects operator credential revocation before and during the Meta handoff', async () => {
    const before = await setup();
    const first = await before.start();
    before.authorization.active = false;
    expect((await before.callback(first.state, first.cookie)).headers.location).toContain('instagram=expired');
    expect(before.calls).toHaveLength(0);
    const during = await setup();
    const second = await during.start();
    during.hooks.beforeSubscription = async () => { during.authorization.active = false; };
    expect((await during.callback(second.state, second.cookie)).headers.location).toContain('instagram=failed');
    expect((await data.db.query('SELECT id FROM social_connections WHERE tenant_id = $1', [during.tenantId])).rowCount).toBe(0);
    expect((await data.db.query('SELECT connection_id FROM instagram_credentials WHERE tenant_id = $1', [during.tenantId])).rowCount).toBe(0);
  });

  it('keeps consent denial, missing permissions and failed webhook subscription disconnected', async () => {
    const denied = await setup();
    const first = await denied.start();
    expect((await denied.callback(first.state, first.cookie, 'access_denied')).headers.location).toContain('instagram=denied');
    expect(denied.calls).toHaveLength(0);
    for (const options of [{ missingScope: true }, { subscriptionFailure: true }]) {
      const ctx = await setup(options);
      const start = await ctx.start();
      expect((await ctx.callback(start.state, start.cookie)).headers.location).toContain('instagram=failed');
      expect((await data.db.query('SELECT id FROM social_connections WHERE tenant_id = $1', [ctx.tenantId])).rowCount).toBe(0);
      expect((await data.db.query('SELECT connection_id FROM instagram_credentials WHERE tenant_id = $1', [ctx.tenantId])).rowCount).toBe(0);
    }
  });

  it('prevents cross-workspace takeover and rejects reconnecting a different Instagram identity', async () => {
    const first = await setup();
    const start = await first.start();
    await first.callback(start.state, start.cookie);
    const connection = (await data.db.query('SELECT id FROM social_connections WHERE tenant_id = $1', [first.tenantId])).rows[0];
    const other = await setup({ accountId: first.accountId });
    const attempt = await other.start();
    expect((await other.callback(attempt.state, attempt.cookie)).headers.location).toContain('instagram=failed');
    expect(other.calls).toHaveLength(3);
    expect((await data.db.query('SELECT tenant_id FROM social_connections WHERE id = $1', [connection.id])).rows[0].tenant_id).toBe(first.tenantId);
    const mistaken = await setup({ tenantId: first.tenantId });
    const reconnect = await mistaken.start(connection.id);
    expect((await mistaken.callback(reconnect.state, reconnect.cookie)).headers.location).toContain('instagram=failed');
    expect((await data.db.query('SELECT token_version FROM instagram_credentials WHERE connection_id = $1', [connection.id])).rows[0].token_version).toBe(1);
  });

  it('refreshes a due token once and fences a late refresh against a completed reconnect', async () => {
    const ctx = await setup();
    const start = await ctx.start();
    await ctx.callback(start.state, start.cookie);
    const credential = (await data.db.query('SELECT * FROM instagram_credentials WHERE tenant_id = $1', [ctx.tenantId])).rows[0];
    await data.db.query('UPDATE instagram_credentials SET refresh_after = now() - interval \'1 second\' WHERE connection_id = $1', [credential.connection_id]);
    let begin!: () => void;
    let complete!: () => void;
    const begun = new Promise<void>((resolve) => { begin = resolve; });
    const pending = new Promise<void>((resolve) => { complete = resolve; });
    let calls = 0;
    const refreshFetch: typeof fetch = async (input, init) => {
      expect(new URL(String(input)).pathname).toBe('/refresh_access_token');
      expect(new URL(String(input)).searchParams.get('grant_type')).toBe('ig_refresh_token');
      expect((init?.headers as Record<string, string>).authorization).toBe('Bearer ' + ctx.longToken);
      calls++; begin(); await pending;
      return json({ access_token: 'older-refreshed-token', expires_in: 5_184_000 });
    };
    const refreshing = refreshInstagramCredentials({ db: data.db, config, fetch: refreshFetch }, credential.connection_id);
    await begun;
    expect(await refreshInstagramCredentials({ db: data.db, config, fetch: refreshFetch }, credential.connection_id)).toBe(false);
    const reconnected = await setup({ tenantId: ctx.tenantId, accountId: ctx.accountId });
    const reconnect = await reconnected.start(credential.connection_id);
    expect((await reconnected.callback(reconnect.state, reconnect.cookie)).headers.location).toBe('/console#accounts');
    complete();
    expect(await refreshing).toBe(false);
    expect(calls).toBe(1);
    expect((await getInstagramCredentials({ db: data.db, encryptionKey: key }, ctx.accountId)).token).toBe(reconnected.longToken);
  });

  it('disconnects the native account, blocks a consent already in flight, and permits fresh reconnection', async () => {
    const ctx = await setup();
    const first = await ctx.start();
    await ctx.callback(first.state, first.cookie);
    const connectionId = (await data.db.query('SELECT id FROM social_connections WHERE tenant_id = $1', [ctx.tenantId])).rows[0].id;
    const other = await setup();
    expect((await other.app.inject({ method: 'POST', url: '/integrations/instagram/accounts/' + connectionId + '/disconnect', headers: { 'x-test-session': other.sessionHash }, payload: {} })).statusCode).toBe(404);
    const pending = await ctx.start(connectionId);
    ctx.hooks.beforeSubscription = async () => {
      const disconnected = await ctx.app.inject({ method: 'POST', url: '/integrations/instagram/accounts/' + connectionId + '/disconnect', headers: { 'x-test-session': ctx.sessionHash }, payload: {} });
      expect(disconnected.json()).toEqual({ disconnected: true });
    };
    expect((await ctx.callback(pending.state, pending.cookie)).headers.location).toContain('instagram=failed');
    const account = (await data.db.query('SELECT status, verified_at, integration_kind FROM social_connections WHERE id = $1', [connectionId])).rows[0];
    expect(account).toMatchObject({ status: 'disconnected', verified_at: null, integration_kind: 'native' });
    expect((await data.db.query('SELECT encrypted_token, token_version FROM instagram_credentials WHERE connection_id = $1', [connectionId])).rows[0]).toEqual({ encrypted_token: '', token_version: 2 });
    await expect(getInstagramCredentials({ db: data.db, encryptionKey: key }, ctx.accountId)).rejects.toMatchObject({ code: 'reconnect_required' });
    ctx.hooks.beforeSubscription = undefined;
    const fresh = await ctx.start(connectionId);
    expect((await ctx.callback(fresh.state, fresh.cookie)).headers.location).toBe('/console#accounts');
    expect(await getInstagramCredentials({ db: data.db, encryptionKey: key }, ctx.accountId)).toMatchObject({ accountId: ctx.accountId, tokenVersion: 3 });
    expect((await data.db.query('SELECT sends_paused FROM social_connections WHERE id = $1', [connectionId])).rows[0].sends_paused).toBe(false);
  });

  it('an HTTP 401 from before disconnect cannot revoke credentials installed after fresh consent', async () => {
    const ctx = await setup();
    const login = await ctx.start();
    await ctx.callback(login.state, login.cookie);
    const first = await getInstagramCredentials({ db: data.db, encryptionKey: key }, ctx.accountId);
    await createAutomation(data.db, { tenantId: ctx.tenantId, connectionId: first.connectionId, name: 'Generation check',
      definition: pricingDefinition, integrationMode: 'native', dispatchConfigured: true });
    const accepted = await ingestEvent({ db: data.db, clock: systemClock, source:'native' }, commentEvent({ accountId: ctx.accountId, from: 'isolated-generation-participant' }));
    if (accepted.status !== 'accepted') throw new Error('Test event rejected');
    const routed = await routeEvent({ db: data.db, clock: systemClock }, accepted.eventId);
    let begun!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => { begun = resolve; });
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const sending = executeSend({ db: data.db, clock: systemClock, integrationMode: 'native', platform: {
      async send() { begun(); await pending; return { status: 'rejected', code: 'unauthorized', httpStatus: 401,
        credentialGeneration: { connectionId: first.connectionId, version: first.tokenVersion } }; },
    } }, { runId: routed.runId!, stepId: 'public_reply', actionNo: 1 });
    await entered;
    expect((await ctx.app.inject({ method: 'POST', url: '/integrations/instagram/accounts/' + first.connectionId + '/disconnect', headers: { 'x-test-session': ctx.sessionHash }, payload: {} })).statusCode).toBe(200);
    const reconnect = await setup({ tenantId: ctx.tenantId, accountId: ctx.accountId });
    const fresh = await reconnect.start(first.connectionId);
    expect((await reconnect.callback(fresh.state, fresh.cookie)).headers.location).toBe('/console#accounts');
    const current = await getInstagramCredentials({ db: data.db, encryptionKey: key }, ctx.accountId);
    expect(current.tokenVersion).toBeGreaterThan(first.tokenVersion);
    expect(current.token).toBe(reconnect.longToken);
    release();
    expect(await sending).toMatchObject({ status: 'rejected' });
    expect((await data.db.query('SELECT status, verified_at, sends_paused FROM social_connections WHERE id = $1', [first.connectionId])).rows[0]).toMatchObject({ status: 'active', sends_paused: false });
    expect((await data.db.query("SELECT id FROM incidents WHERE connection_id = $1 AND error_class = 'connection_unauthorized' AND status = 'open'", [first.connectionId])).rowCount).toBe(0);
    expect((await getInstagramCredentials({ db: data.db, encryptionKey: key }, ctx.accountId)).tokenVersion).toBe(current.tokenVersion);
  });

  it('a failed refresh from an expired claim cannot revoke a newer refresh of the same generation', async () => {
    const ctx = await setup();
    const login = await ctx.start();
    await ctx.callback(login.state, login.cookie);
    const credential = (await data.db.query('SELECT * FROM instagram_credentials WHERE tenant_id = $1', [ctx.tenantId])).rows[0];
    await data.db.query('UPDATE instagram_credentials SET refresh_after = now() - interval \'1 second\' WHERE connection_id = $1', [credential.connection_id]);
    let begun!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => { begun = resolve; });
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const firstFetch: typeof fetch = async () => { begun(); await pending; return json({ error: { code: 190 } }, 400); };
    const old = refreshInstagramCredentials({ db: data.db, config, fetch: firstFetch }, credential.connection_id);
    await entered;
    await data.db.query('UPDATE instagram_credentials SET refreshing_until = now() - interval \'1 second\' WHERE connection_id = $1', [credential.connection_id]);
    let secondRelease!: () => void;
    let secondBegun!: () => void;
    const secondEntered = new Promise<void>((resolve) => { secondBegun = resolve; });
    const secondPending = new Promise<void>((resolve) => { secondRelease = resolve; });
    const secondFetch: typeof fetch = async () => { secondBegun(); await secondPending; return json({ access_token: 'current-refreshed-token', expires_in: 5_184_000 }); };
    const current = refreshInstagramCredentials({ db: data.db, config, fetch: secondFetch }, credential.connection_id);
    await secondEntered;
    release();
    expect(await old).toBe(false);
    expect((await data.db.query('SELECT status FROM social_connections WHERE id = $1', [credential.connection_id])).rows[0].status).toBe('active');
    secondRelease();
    expect(await current).toBe(true);
    expect((await getInstagramCredentials({ db: data.db, encryptionKey: key }, ctx.accountId)).token).toBe('current-refreshed-token');
  });

  it('marks expired or rejected credentials as requiring reconnect and records an incident', async () => {
    const ctx = await setup();
    const start = await ctx.start();
    await ctx.callback(start.state, start.cookie);
    const credential = (await data.db.query('SELECT * FROM instagram_credentials WHERE tenant_id = $1', [ctx.tenantId])).rows[0];
    await data.db.query('UPDATE instagram_credentials SET refresh_after = now() - interval \'1 second\' WHERE connection_id = $1', [credential.connection_id]);
    const rejected: typeof fetch = async () => json({ error: { code: 190 } }, 400);
    await expect(getInstagramCredentials({ db: data.db, encryptionKey: key, fetch: rejected }, ctx.accountId)).rejects.toMatchObject({ code: 'reconnect_required' });
    const connection = (await data.db.query('SELECT status, verified_at, sends_paused FROM social_connections WHERE id = $1', [credential.connection_id])).rows[0];
    expect(connection).toMatchObject({ status: 'unauthorized', verified_at: null, sends_paused: true });
    expect((await data.db.query("SELECT error_class FROM incidents WHERE connection_id = $1 AND status = 'open'", [credential.connection_id])).rows[0].error_class).toBe('connection_unauthorized');
  });
});
