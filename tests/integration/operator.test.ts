import { randomUUID, createHmac } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerOperator } from '../../src/api/operator';
import { withTx } from '../../src/storage/db';
import { raiseIncident } from '../../src/alerts/incidents';
import { createAutomation, createTenant } from '../../src/storage/admin';
import { DEFAULT_CAPABILITIES } from '../helpers/account';
import { systemClock } from '../../src/domain/clock';
import { createTestDb } from '../helpers/db';

const secret = 'isolated-test-account-provisioning-secret';
const content = {
  keyword: 'pricing', publicReply: 'Sent you a DM!', emailPrompt: 'Please reply with your email.',
  linkText: 'Here is the requested link.', linkUrl: 'https://company.example/pricing', timeoutHours: 72,
  maxClarifications: 1, clarificationText: 'Please send one email address.',
};

describe('operator drafts and trusted accounts', () => {
  let data: Awaited<ReturnType<typeof createTestDb>>;
  const servers: FastifyInstance[] = [];
  function server(dispatchConfigured = true, integrationMode: 'native' | 'gateway' | 'unconfigured' = 'gateway') {
    const app = Fastify();
    registerOperator(app, { db: data.db, clock: systemClock, dispatchConfigured, integrationMode, provisioningSecret: secret }, (req, reply) => {
      const tenant = req.headers['x-tenant-id'];
      if (typeof tenant === 'string') return tenant;
      reply.code(401).send({ error: 'A workspace identity is required.' });
      return undefined;
    });
    servers.push(app);
    return app;
  }
  const headers = (tenant: string) => ({ 'x-tenant-id': tenant });
  async function account(app: FastifyInstance, tenantId: string, options: { accountId?: string; revision?: number; status?: string; eventId?: string } = {}) {
    const envelope = {
      type: 'instagram.account.updated', eventId: options.eventId ?? randomUUID(), tenantId,
      accountId: options.accountId ?? 'isolated-' + randomUUID(), displayName: 'Customer account', status: options.status ?? 'active',
      capabilities: DEFAULT_CAPABILITIES, integrationRevision: options.revision ?? 1, occurredAt: new Date().toISOString(),
    };
    const raw = JSON.stringify(envelope);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = 'sha256=' + createHmac('sha256', secret).update(timestamp + '.' + raw).digest('hex');
    const deliver = () => app.inject({ method: 'POST', url: '/integrations/accounts', payload: raw,
      headers: { 'content-type': 'application/json', 'x-integration-timestamp': timestamp, 'x-integration-signature': signature } });
    return { envelope, deliver, response: await deliver() };
  }
  async function create(app: FastifyInstance, tenant: string, connectionId?: string) {
    const res = await app.inject({ method: 'POST', url: '/operator/automations', headers: headers(tenant), payload: { name: 'Pricing', content, connectionId } });
    expect(res.statusCode).toBe(201);
    return res.json().draft;
  }
  const publish = (app: FastifyInstance, tenant: string, id: string, expectedRevision: number) => app.inject({
    method: 'POST', url: '/operator/automations/' + id + '/publish', headers: headers(tenant), payload: { expectedRevision },
  });
  beforeAll(async () => { data = await createTestDb(); });
  afterAll(async () => { await Promise.all(servers.map((app) => app.close())); await data?.drop(); });

  it('points to an invalid pasted field and keeps the saved draft intact for a correction', async () => {
    const tenantId = await createTenant(data.db, 'Draft validation');
    const app = server();
    const draft = await create(app, tenantId);
    const edit = (publicReply: string) => app.inject({
      method: 'PATCH', url: '/operator/automations/' + draft.id, headers: headers(tenantId),
      payload: { expectedRevision: draft.revision, content: { publicReply } },
    });
    const rejected = await edit('paste\u0000here');
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json().issues).toEqual([expect.objectContaining({ field: 'content.publicReply' })]);
    const corrected = await edit('Всё готово 👩‍💻');
    expect(corrected.statusCode).toBe(200);
    expect(corrected.json().draft).toMatchObject({ revision: draft.revision + 1, content: { publicReply: 'Всё готово 👩‍💻' } });
  });

  it('starts empty and persists a partial draft without inventing an account or an execution', async () => {
    const tenant = await createTenant(data.db, 'Operator workspace');
    const app = server();
    const initial = await app.inject({ url: '/operator/overview', headers: headers(tenant) });
    expect(initial.json()).toMatchObject({ automationsActive: 0, drafts: 0, conversationsStarted: 0, emailsCollected: 0, readiness: { accountConnected: false, canPublish: false } });
    const saved = await app.inject({ method: 'POST', url: '/operator/automations', headers: headers(tenant), payload: { name: 'First automation', content: { keyword: 'pricing' } } });
    expect(saved.statusCode).toBe(201);
    const draft = saved.json().draft;
    expect(draft).toMatchObject({ name: 'First automation', revision: 1, connectionId: null, automationId: null, status: 'draft', content: { keyword: 'pricing' } });
    const reopened = await server().inject({ url: '/operator/automations/' + draft.id, headers: headers(tenant) });
    expect(reopened.json().draft).toEqual(draft);
    expect((await publish(app, tenant, draft.id, 1)).statusCode).toBe(409);
    expect((await data.db.query('SELECT count(*)::int n FROM social_connections WHERE tenant_id = $1', [tenant])).rows[0].n).toBe(0);
    expect((await data.db.query('SELECT count(*)::int n FROM automation_runs WHERE tenant_id = $1', [tenant])).rows[0].n).toBe(0);
  });

  it('prevents lost edits and cross-workspace reads', async () => {
    const tenant = await createTenant(data.db, 'Concurrent editor');
    const other = await createTenant(data.db, 'Other editor');
    const app = server();
    const draft = await create(app, tenant);
    const edits = await Promise.all(['A', 'B'].map((name) => app.inject({ method: 'PATCH', url: '/operator/automations/' + draft.id,
      headers: headers(tenant), payload: { expectedRevision: 1, name } })));
    expect(edits.map((edit) => edit.statusCode).sort()).toEqual([200, 409]);
    const denied = await app.inject({ url: '/operator/automations/' + draft.id, headers: headers(other) });
    expect(denied.statusCode).toBe(404);
    expect((await app.inject({ url: '/operator/automations', headers: headers(other) })).json().drafts).toEqual([]);
  });

  it('accepts account state only through signed, ordered integration events and prevents a tenant takeover', async () => {
    const app = server();
    const tenant = await createTenant(data.db, 'Connected operator');
    const other = await createTenant(data.db, 'Other operator');
    const accountId = 'real-contract-' + randomUUID();
    expect((await app.inject({ method: 'POST', url: '/integrations/accounts', payload: { accountId } })).statusCode).toBe(401);
    expect((await account(app, tenant, { accountId: ' ' + accountId, status: 'unauthorized' })).response.statusCode).toBe(400);
    const connected = await account(app, tenant, { accountId });
    expect(connected.response.statusCode).toBe(200);
    expect((await connected.deliver()).json()).toEqual({ duplicate: true });
    const conflict = await account(app, other, { accountId, revision: 2 });
    expect(conflict.response.statusCode).toBe(409);
    const revoked = await account(app, tenant, { accountId, revision: 3, status: 'unauthorized' });
    expect(revoked.response.statusCode).toBe(200);
    expect((await account(app, tenant, { accountId, revision: 2 })).response.json().stale).toBe(true);
    const accounts = (await app.inject({ url: '/operator/accounts', headers: headers(tenant) })).json().accounts;
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({ status: 'unauthorized', verifiedAt: null, canPublish: false, issue: 'reconnect_required' });
    expect((await app.inject({ url: '/operator/accounts', headers: headers(other) })).json().accounts).toEqual([]);
  });

  it('publishes one immutable version per draft revision and preserves the previous definition', async () => {
    const app = server();
    const tenant = await createTenant(data.db, 'Publishing operator');
    const connected = await account(app, tenant);
    const connectionId = connected.response.json().connectionId;
    const draft = await create(app, tenant, connectionId);
    const [first, duplicate] = await Promise.all([publish(app, tenant, draft.id, 1), publish(app, tenant, draft.id, 1)]);
    expect(first.statusCode).toBe(200);
    expect(duplicate.statusCode).toBe(200);
    expect(duplicate.json().versionId).toBe(first.json().versionId);
    await data.db.query("UPDATE automations SET status = 'disabled' WHERE id = $1", [first.json().automationId]);
    expect((await publish(app, tenant, draft.id, 1)).json().draft.status).toBe('paused');
    expect((await data.db.query('SELECT status FROM automations WHERE id = $1', [first.json().automationId])).rows[0].status).toBe('disabled');
    const saved = await app.inject({ method: 'PATCH', url: '/operator/automations/' + draft.id, headers: headers(tenant),
      payload: { expectedRevision: 1, content: { ...content, linkUrl: 'https://company.example/new' } } });
    expect(saved.statusCode).toBe(200);
    expect((await publish(app, tenant, draft.id, 1)).statusCode).toBe(409);
    const second = await publish(app, tenant, draft.id, 2);
    expect(second.json()).toMatchObject({ automationId: first.json().automationId, version: 2, draft: { revision: 2, publishedRevision: 2 } });
    const versions = (await data.db.query('SELECT definition FROM automation_versions WHERE automation_id = $1 ORDER BY version', [first.json().automationId])).rows;
    expect(versions).toHaveLength(2);
    expect(versions[0].definition.steps[3].text).toContain('https://company.example/pricing');
    expect(versions[1].definition.steps[3].text).toContain('https://company.example/new');
  });

  it('a verified reconnect clears the revoked-access pause and resolves its incident', async () => {
    const tenant = await createTenant(data.db, 'Reconnected workspace');
    const app = server();
    const connected = await account(app, tenant);
    const connectionId = connected.response.json().connectionId;
    await data.db.query("UPDATE social_connections SET status = 'unauthorized', sends_paused = true, sends_paused_reason = 'provider_unauthorized' WHERE id = $1", [connectionId]);
    await withTx(data.db, (c) => raiseIncident(c, { tenantId: tenant, connectionId, errorClass: 'connection_unauthorized' }));
    expect((await account(app, tenant, { accountId: connected.envelope.accountId, revision: 2 })).response.statusCode).toBe(200);
    const state = (await data.db.query('SELECT status, sends_paused, sends_paused_reason, verified_at FROM social_connections WHERE id = $1', [connectionId])).rows[0];
    expect(state).toMatchObject({ status: 'active', sends_paused: false, sends_paused_reason: null });
    expect(state.verified_at).toBeInstanceOf(Date);
    expect((await data.db.query('SELECT status FROM incidents WHERE connection_id = $1', [connectionId])).rows[0].status).toBe('resolved');
  });

  it('keeps native and gateway account credentials separate when deployment mode changes', async () => {
    const tenant = await createTenant(data.db, 'Integration mode operator');
    const gateway = server();
    const native = server(true, 'native');
    const connected = await account(gateway, tenant);
    const connectionId = connected.response.json().connectionId;
    const draft = await create(gateway, tenant, connectionId);
    expect((await account(native, tenant)).response.statusCode).toBe(503);
    expect((await publish(native, tenant, draft.id, 1)).json().code).toBe('reconnect_required');
    await data.db.query("UPDATE social_connections SET integration_kind = 'native' WHERE id = $1", [connectionId]);
    await data.db.query(`INSERT INTO instagram_credentials (connection_id, tenant_id, encrypted_token, expires_at, refresh_after, granted_scopes)
      VALUES ($1, $2, 'isolated-test-ciphertext', now() + interval '1 day', now() + interval '12 hours', '{}')`, [connectionId, tenant]);
    const visible = (await native.inject({ url: '/operator/accounts', headers: headers(tenant) })).json().accounts[0];
    expect(visible).toMatchObject({ source: 'native', canDisconnect: true, canPublish: true });
    expect((await publish(gateway, tenant, draft.id, 1)).json().code).toBe('integration_mismatch');
    expect((await publish(native, tenant, draft.id, 1)).statusCode).toBe(200);
    await data.db.query('DELETE FROM instagram_credentials WHERE connection_id = $1', [connectionId]);
    expect((await gateway.inject({ url: '/operator/accounts', headers: headers(tenant) })).json().accounts[0]).toMatchObject({ source: 'native', canPublish: false });
    expect((await account(gateway, tenant, { accountId: connected.envelope.accountId, revision: 2 })).response.json().code).toBe('integration_mismatch');
  });

  it('opens an existing custom automation for reading without converting its sequence into the pricing form', async () => {
    const tenant = await createTenant(data.db, 'Existing custom rules');
    const app = server();
    const connected = await account(app, tenant);
    const definition = { schemaVersion: 1, trigger: { type: 'comment.created', platform: 'instagram', keyword: 'hello', match: 'whole_word_case_insensitive', posts: 'all_supported' },
      steps: [{ id: 'hello', type: 'reply_comment', text: 'Hello there' }] };
    const rule = await createAutomation(data.db, { tenantId: tenant, connectionId: connected.response.json().connectionId, name: 'Custom greeting', definition, integrationMode: 'gateway', dispatchConfigured: true });
    const result = await app.inject({ url: '/operator/automations/' + rule.automationId, headers: headers(tenant) });
    expect(result.json().automation).toMatchObject({ id: rule.automationId, name: 'Custom greeting', definition, editable: false });
    expect((await data.db.query('SELECT id FROM automation_drafts WHERE automation_id = $1', [rule.automationId])).rowCount).toBe(0);
  });

  it('uses the latest verified account state after waiting for concurrent account provisioning', async () => {
    const app = server();
    const tenant = await createTenant(data.db, 'Account publication race');
    const connected = await account(app, tenant);
    const connectionId = connected.response.json().connectionId;
    const draft = await create(app, tenant, connectionId);
    const owner = await data.db.connect();
    await owner.query('BEGIN');
    await owner.query('SELECT 1 FROM social_connections WHERE id = $1 FOR NO KEY UPDATE', [connectionId]);
    const publishing = publish(app, tenant, draft.id, 1).then((result) => result);
    try {
      let blocked = false;
      for (let i = 0; i < 100 && !blocked; i++) {
        blocked = !!(await data.db.query("SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE 'SELECT sc.status, sc.sends_paused, sc.capabilities%'")).rowCount;
        if (!blocked) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(blocked).toBe(true);
      await owner.query("UPDATE social_connections SET status = 'unauthorized', verified_at = NULL WHERE id = $1", [connectionId]);
      await owner.query('COMMIT');
    } finally {
      await owner.query('ROLLBACK');
      owner.release();
    }
    expect((await publishing).json().code).toBe('reconnect_required');
    expect((await data.db.query('SELECT count(*)::int n FROM automations WHERE tenant_id = $1', [tenant])).rows[0].n).toBe(0);
  });

  it('blocks publishing when delivery is unconfigured, account state changes, or content is invalid', async () => {
    const tenant = await createTenant(data.db, 'Blocked publisher');
    const app = server();
    const connected = await account(app, tenant);
    const draft = await create(app, tenant, connected.response.json().connectionId);
    expect((await publish(server(false), tenant, draft.id, 1)).json().code).toBe('delivery_unconfigured');
    await account(app, tenant, { accountId: connected.envelope.accountId, revision: 2, status: 'disconnected' });
    expect((await publish(app, tenant, draft.id, 1)).json().code).toBe('reconnect_required');
    await account(app, tenant, { accountId: connected.envelope.accountId, revision: 3 });
    await app.inject({ method: 'PATCH', url: '/operator/automations/' + draft.id, headers: headers(tenant), payload: { expectedRevision: 1, content: { ...content, linkUrl: 'javascript:alert(1)' } } });
    expect((await publish(app, tenant, draft.id, 2)).json().code).toBe('invalid_link');
    expect((await data.db.query('SELECT count(*)::int n FROM automations WHERE tenant_id = $1', [tenant])).rows[0].n).toBe(0);
  });
});
