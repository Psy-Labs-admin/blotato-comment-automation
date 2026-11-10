import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { Client, Connection } from '@temporalio/client';
import { NativeConnection } from '@temporalio/worker';
import { expect, inject, it, vi } from 'vitest';
import { buildServer } from '../../src/api/server';
import { systemClock } from '../../src/domain/clock';
import { DEFAULT_CAPABILITIES } from '../helpers/account';
import { getInstagramCredentials } from '../../src/instagram/accounts';
import { INSTAGRAM_SCOPES, type InstagramConfig } from '../../src/instagram/config';
import { InstagramGraphPlatform } from '../../src/instagram/platform';
import { routePending } from '../../src/ingest/router';
import { metadataHandler } from '../../src/metadata/hydrate';
import { integrationHandlers, onDeadLetter } from '../../src/relay/integrations';
import { OutboxRelay } from '../../src/relay/relay';
import { createTenant } from '../../src/storage/admin';
import { temporalHandlers } from '../../src/temporal/handlers';
import type { RunningWorker } from '../../src/temporal/worker';
import { startTestWorker as startWorker } from '../helpers/workflow-coverage';
import { createTestDb } from '../helpers/db';
import { createTestAccess } from '../helpers/test-access';

/** One disposable workspace exercises the native HTTP entry points and the durable worker together. */
it.each([
  { scenario: 'clean duplicated reply', rejected: [] },
  { scenario: 'malformed address then two addresses in one DM', rejected: [
    { text: 'buyer@example.com@other.io', result: 'invalid', reason: 'email_invalid' },
    { text: 'buyer@example.com or other@example.org', result: 'ambiguous', reason: 'email_ambiguous' },
  ] },
  { scenario: 'invisible character in address', rejected: [
    { text: 'al\u200Bice@example.com', result: 'invalid', reason: 'email_invalid' },
  ] },
])('connects Instagram, publishes a draft, and captures one corrected lead and link: $scenario', async ({ rejected }) => {
  const data = await createTestDb();
  const auth = createTestAccess();
  const tenantId = await createTenant(data.db, 'Native journey verification');
  const accountId = '178400000000001';
  const participantId = '178400000000002';
  const commentId = '179000000000001';
  const mediaId = '180000000000001';
  const longToken = 'test-only-meta-long-token-' + randomUUID();
  const config: InstagramConfig = {
    appId: '123456789012345', appSecret: 'test-only-instagram-secret', webhookAppSecret: 'test-only-meta-webhook-secret',
    redirectUri: 'https://operator.example/integrations/instagram/callback', encryptionKey: randomBytes(32),
    graphVersion: 'v24.0', webhookVerifyToken: 'test-only-webhook-verification',
    capabilities: { ...DEFAULT_CAPABILITIES, reconciliation: 'none' },
  };
  const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
  const oauthCalls: string[] = [];
  const sends: Array<{ path: string; body: unknown; authorization: string | null }> = [];
  const transport: typeof fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.hostname === 'api.instagram.com' && url.pathname === '/oauth/access_token') {
      oauthCalls.push('exchange');
      const body = new URLSearchParams(String(init.body));
      expect(body.get('code')).toBe('test-only-code');
      expect(body.get('client_secret')).toBe(config.appSecret);
      return json({ access_token: 'test-only-short-token', user_id: 'oauth-scoped-user', permissions: INSTAGRAM_SCOPES });
    }
    if (url.hostname === 'graph.instagram.com' && url.pathname === '/access_token') {
      oauthCalls.push('long-token');
      expect(url.searchParams.get('access_token')).toBe('test-only-short-token');
      return json({ access_token: longToken, expires_in: 5_184_000 });
    }
    expect(url.origin).toBe('https://graph.instagram.com');
    const authorization = new Headers(init.headers).get('authorization');
    expect(authorization).toBe('Bearer ' + longToken);
    if (url.pathname === '/v24.0/me') {
      oauthCalls.push('profile');
      return json({ id: 'different-app-scoped-id', user_id: accountId, username: 'journey_owner' });
    }
    if (url.pathname === '/v24.0/me/subscribed_apps') {
      oauthCalls.push('subscribe');
      expect(new URLSearchParams(String(init.body)).get('subscribed_fields')).toBe('comments,messages');
      return json({ success: true });
    }
    if (url.pathname === '/v24.0/' + mediaId && (!init.method || init.method === 'GET')) {
      return json({ id: mediaId, caption: 'Test-only post metadata', media_type: 'IMAGE', permalink: 'https://www.instagram.com/p/test-only/' });
    }
    if (init.method === 'POST' && [
      '/v24.0/' + commentId + '/replies', '/v24.0/' + accountId + '/messages',
    ].includes(url.pathname)) {
      sends.push({ path: url.pathname, body: JSON.parse(String(init.body)), authorization });
      return json({ message_id: 'test-only-message-' + sends.length });
    }
    throw new Error('Unexpected external endpoint in the isolated native journey');
  };
  vi.stubGlobal('fetch', transport);
  const relays: OutboxRelay[] = [];
  const poke = () => relays.forEach((relay) => relay.poke());
  const app = buildServer({
    db: data.db, access: auth.access, clock: systemClock, nativeInstagram: config,
    dispatchConfigured: true, integrationMode: 'native', onOutbox: poke, logger: false,
  });
  let connection: Connection | undefined;
  let native: NativeConnection | undefined;
  let worker: RunningWorker | undefined;
  const crm = new Map<string, unknown>();
  try {
    const baseHeaders = { host: 'localhost', origin: 'http://localhost' };
    const login = await app.inject({ method: 'POST', url: '/session', headers: baseHeaders,
      payload: { token: auth.operatorHeaders(tenantId).authorization.slice(7) } });
    expect(login.statusCode).toBe(200);
    expect(login.headers['set-cookie']).toContain('HttpOnly');
    const sessionCookie = String(login.headers['set-cookie']).split(';')[0];
    const session = { ...baseHeaders, cookie: sessionCookie };
    const workspace = await app.inject({ url: '/workspace', headers: session });
    expect(workspace.statusCode).toBe(200);
    const csrf = { ...session, 'x-csrf-token': workspace.json().csrfToken };
    expect((await app.inject({ url: '/operator/accounts', headers: session })).json().accounts).toEqual([]);

    const connect = await app.inject({ method: 'POST', url: '/integrations/instagram/connect', headers: csrf, payload: {} });
    expect(connect.statusCode).toBe(200);
    const oauthUrl = new URL(connect.json().url);
    expect(oauthUrl.origin).toBe('https://www.instagram.com');
    const callback = await app.inject({
      url: '/integrations/instagram/callback?' + new URLSearchParams({ state: oauthUrl.searchParams.get('state')!, code: 'test-only-code' }),
      headers: { host: 'localhost', cookie: String(connect.headers['set-cookie']).split(';')[0] },
    });
    expect(callback.statusCode).toBe(302);
    expect(callback.headers.location).toBe('/console#accounts');
    expect(oauthCalls).toEqual(['exchange', 'long-token', 'profile', 'subscribe']);
    const accounts = (await app.inject({ url: '/operator/accounts', headers: session })).json().accounts;
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({ accountId, displayName: 'journey_owner', source: 'native', canPublish: true });
    const connectionId = accounts[0].id;
    const credential = (await data.db.query('SELECT encrypted_token FROM instagram_credentials WHERE connection_id=$1', [connectionId])).rows[0];
    expect(credential.encrypted_token).not.toContain(longToken);
    expect((await getInstagramCredentials({ db: data.db, encryptionKey: config.encryptionKey }, accountId)).token).toBe(longToken);

    const content = { keyword: 'pricing', publicReply: 'Sent you a DM!', emailPrompt: 'Reply with your email address.',
      linkText: 'Here is the requested information.', linkUrl: 'https://example.org/pricing', timeoutHours: 1,
      maxClarifications: 1, clarificationText: 'Please send a valid email address.' };
    expect((await app.inject({ method: 'POST', url: '/operator/automations', headers: session,
      payload: { name: 'Native pricing', connectionId, content } })).statusCode).toBe(403);
    const saved = await app.inject({ method: 'POST', url: '/operator/automations', headers: csrf,
      payload: { name: 'Native pricing', connectionId, content } });
    expect(saved.statusCode).toBe(201);
    const draft = saved.json().draft;
    const published = await app.inject({ method: 'POST', url: '/operator/automations/' + draft.id + '/publish', headers: csrf,
      payload: { expectedRevision: draft.revision } });
    expect(published.statusCode).toBe(200);

    const address = inject('temporalAddress');
    connection = await Connection.connect({ address });
    native = await NativeConnection.connect({ address });
    const client = new Client({ connection });
    const taskQueue = 'native-journey-' + randomUUID();
    const platform = new InstagramGraphPlatform({ graphVersion: config.graphVersion, fetch: transport,
      credentials: (id) => getInstagramCredentials({ db: data.db, encryptionKey: config.encryptionKey }, id) });
    relays.push(
      new OutboxRelay({ db: data.db, kinds: ['workflow.start', 'workflow.signal'],
        handlers: temporalHandlers({ client, db: data.db, taskQueue, recheckMs: 100 }), pollMs: 20,
        maxAttempts: Number.POSITIVE_INFINITY, onDead: onDeadLetter }),
      new OutboxRelay({ db: data.db, kinds: ['crm.lead_captured', 'alert.notify'],
        handlers: integrationHandlers({ db: data.db, crm: { upsertLead: async (lead, key) => { crm.set(key, lead); } },
          notifier: { notify: async () => undefined } }), pollMs: 20, onDead: onDeadLetter }),
      new OutboxRelay({ db: data.db, kinds: ['metadata.hydrate'],
        handlers: { 'metadata.hydrate': metadataHandler({ db: data.db, client: platform }) }, pollMs: 20, onDead: onDeadLetter }),
    );
    worker = await startWorker({ connection: native, taskQueue,
      deps: { db: data.db, clock: systemClock, integrationMode: 'native', platform, onOutbox: poke } });
    relays.forEach((relay) => relay.start());
    const deliver = async (payload: unknown) => {
      const raw = JSON.stringify(payload);
      return app.inject({ method: 'POST', url: '/integrations/instagram/webhook', payload: raw,
        headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=' + createHmac('sha256', config.webhookAppSecret).update(raw).digest('hex') } });
    };
    async function until<T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
      for (let attempt = 0; attempt < 200; attempt++) {
        await routePending({ db: data.db, clock: systemClock, onOutbox: poke });
        const value = await read();
        if (ready(value)) return value;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error('Native journey did not reach the expected durable state');
    }
    const comment = { object: 'instagram', entry: [{ id: accountId, time: Math.floor(Date.now() / 1000), changes: [
      { field: 'comments', value: { id: commentId, from: { id: participantId, username: 'journey_participant' },
        media: { id: mediaId }, text: 'Pricing please', timestamp: new Date().toISOString() } },
    ] }] };
    const commentAcks = await Promise.all([deliver(comment), deliver(comment)]);
    expect(commentAcks.map((response) => response.statusCode)).toEqual([200, 200]);
    const run = await until(async () => (await data.db.query('SELECT id,status FROM automation_runs WHERE tenant_id=$1', [tenantId])).rows[0],
      (value) => value?.status === 'waiting_input');
    expect(sends).toHaveLength(2);
    const messagePayload = (mid: string, text: string) => ({
      object: 'instagram', entry: [{ id: accountId, time: Math.floor(Date.now() / 1000), messaging: [
        { sender: { id: participantId }, recipient: { id: accountId }, timestamp: Date.now(), message: { mid, text } },
      ] }],
    });
    for (const [index, input] of rejected.entries()) {
      expect((await deliver(messagePayload('test-only-rejected-' + index, input.text))).statusCode).toBe(200);
      // A durable decision proves the worker evaluated this exact message before the negative assertions.
      const decision = await until(async () => (await data.db.query(`
        SELECT ic.result,a.reason FROM input_consumptions ic
        JOIN inbox_events e ON e.id=ic.inbox_event_id
        JOIN run_audit_events a ON a.inbox_event_id=e.id AND a.type='input.rejected'
        JOIN input_waits w ON w.id=ic.wait_id WHERE w.run_id=$1 AND e.text=$2`, [run.id, input.text])).rows[0],
      (value) => value !== undefined);
      expect(decision).toEqual({ result: input.result, reason: input.reason });
      await until(async () => (await data.db.query(`SELECT status FROM message_intents
        WHERE run_id=$1 AND step_id='email' AND action_no=2`, [run.id])).rows[0],
      (value) => value?.status === 'accepted');
      expect((await data.db.query('SELECT status,clarifications_used FROM input_waits WHERE run_id=$1', [run.id])).rows)
        .toEqual([{ status: 'active', clarifications_used: 1 }]);
      expect((await data.db.query('SELECT status FROM automation_runs WHERE id=$1', [run.id])).rows[0].status).toBe('waiting_input');
      expect((await data.db.query('SELECT id FROM leads WHERE run_id=$1', [run.id])).rowCount).toBe(0);
      expect((await data.db.query("SELECT id FROM outbox WHERE kind='crm.lead_captured'")).rowCount).toBe(0);
      expect(crm.size).toBe(0);
      expect(sends).toHaveLength(3);
      expect(sends[2].body).toEqual({ recipient: { id: participantId }, message: { text: content.clarificationText } });
      expect((await data.db.query("SELECT id FROM message_intents WHERE run_id=$1 AND step_id='send_link'", [run.id])).rowCount).toBe(0);
    }
    const message = messagePayload('test-only-inbound-email', 'journey@example.org');
    const messageAcks = await Promise.all([deliver(message), deliver(message)]);
    expect(messageAcks.map((response) => response.statusCode)).toEqual([200, 200]);
    await until(async () => (await data.db.query(`SELECT r.status,l.crm_status FROM automation_runs r
      LEFT JOIN leads l ON l.run_id=r.id WHERE r.id=$1`, [run.id])).rows[0],
      (value) => value.status === 'completed' && value.crm_status === 'synced');
    expect(sends).toEqual([
      { path: '/v24.0/' + commentId + '/replies', body: { message: content.publicReply }, authorization: 'Bearer ' + longToken },
      { path: '/v24.0/' + accountId + '/messages', body: { recipient: { comment_id: commentId }, message: { text: content.emailPrompt } }, authorization: 'Bearer ' + longToken },
      ...(rejected.length ? [{ path: '/v24.0/' + accountId + '/messages', body: { recipient: { id: participantId }, message: { text: content.clarificationText } }, authorization: 'Bearer ' + longToken }] : []),
      { path: '/v24.0/' + accountId + '/messages', body: { recipient: { id: participantId }, message: { text: content.linkText + '\n' + content.linkUrl } }, authorization: 'Bearer ' + longToken },
    ]);
    expect((await data.db.query('SELECT id FROM automation_runs')).rowCount).toBe(1);
    expect((await data.db.query('SELECT email FROM leads')).rows).toEqual([{ email: 'journey@example.org' }]);
    expect((await data.db.query('SELECT id FROM inbox_events')).rowCount).toBe(2 + rejected.length);
    expect((await data.db.query("SELECT status FROM message_intents ORDER BY created_at")).rows).toEqual([
      { status: 'accepted' }, { status: 'accepted' },
      ...(rejected.length ? [{ status: 'accepted' }] : []), { status: 'accepted' },
    ]);
    expect((await data.db.query(`SELECT ic.result FROM input_consumptions ic
      JOIN input_waits w ON w.id=ic.wait_id WHERE w.run_id=$1 ORDER BY ic.created_at`, [run.id])).rows)
      .toEqual([...rejected.map(({ result }) => ({ result })), { result: 'valid' }]);
    expect(crm.size).toBe(1);
  } finally {
    await app.close();
    await Promise.all(relays.map((relay) => relay.stop()));
    await worker?.shutdown();
    await native?.close();
    await connection?.close();
    vi.unstubAllGlobals();
    await data.drop();
  }
});
