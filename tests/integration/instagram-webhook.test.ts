import { createAutomation } from '../../src/storage/admin';
import { pricingDefinition } from '../helpers/definitions';
import { ingestEvent } from '../../src/ingest/ingest';
import { routeEvent } from '../../src/ingest/router';
import { commentEvent } from '../helpers/fixtures';
import { createHmac } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerInstagramWebhook } from '../../src/instagram/webhook';
import { createInstagramWebhookServer, loadInstagramWebhookServerConfig } from '../../src/instagram/webhook-server';
import { systemClock } from '../../src/domain/clock';
import { createTestDb } from '../helpers/db';
import { seedTenant } from '../helpers/fixtures';

describe('native Instagram webhook', () => {
  let data: Awaited<ReturnType<typeof createTestDb>>;
  let app: FastifyInstance;
  let account: Awaited<ReturnType<typeof seedTenant>>;
  const secret = 'meta-application-signature-secret';
  const verify = 'separate-webhook-verification-token';
  const delivery = (payload: unknown, valid = true) => {
    const raw = JSON.stringify(payload);
    return app.inject({ method: 'POST', url: '/integrations/instagram/webhook', payload: raw,
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=' + createHmac('sha256', valid ? secret : 'invalid').update(raw).digest('hex') } });
  };
  const comment = (id: string) => ({ field: 'comments', value: { id, text: 'pricing', from: { id: 'customer' }, media: { id: 'post' } } });
  const batch = (ids: string[]) => ({ object: 'instagram', entry: [{ id: account.accountId, time: Math.floor(Date.now() / 1000), changes: ids.map(comment) }] });

  beforeAll(async () => {
    data = await createTestDb();
    account = await seedTenant(data.db, { accountId: '178414000000001' });
    await data.db.query(`INSERT INTO instagram_credentials(connection_id,tenant_id,encrypted_token,expires_at,refresh_after,granted_scopes)
      VALUES($1,$2,'test-only-not-used-by-webhook',now()+interval '1 day',now()+interval '12 hours','{}')`, [account.connectionId, account.tenantId]);
    await data.db.query("UPDATE social_connections SET integration_kind='native' WHERE id=$1", [account.connectionId]);
    app = Fastify({ logger: false });
    registerInstagramWebhook(app, { db: data.db, clock: systemClock, appSecret: secret, verifyToken: verify });
  });
  afterAll(async () => { await app?.close(); await data?.drop(); });

  it('answers Meta verification only for the configured verification token', async () => {
    const path = '/integrations/instagram/webhook?hub.mode=subscribe&hub.challenge=challenge-123&hub.verify_token=';
    const response = await app.inject(path + verify);
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('challenge-123');
    expect((await app.inject(path + secret)).statusCode).toBe(403);
  });

  it('verifies the exact signed body before storing comments and deduplicates provider IDs', async () => {
    expect((await delivery(batch(['first']), false)).statusCode).toBe(401);
    expect((await data.db.query('SELECT id FROM inbox_events')).rowCount).toBe(0);
    expect((await delivery(batch(['first']))).statusCode).toBe(200);
    expect((await delivery(batch(['first']))).statusCode).toBe(200);
    expect((await data.db.query("SELECT id FROM inbox_events WHERE provider_event_key='first'")).rowCount).toBe(1);
  });

  it('ingests through the isolated listener with webhook credentials only', async () => {
    const isolated = createInstagramWebhookServer(loadInstagramWebhookServerConfig({
      INSTAGRAM_WEBHOOK_VERIFY_TOKEN: verify, META_APP_SECRET: secret, DATABASE_URL: data.url,
    }), data.db);
    const raw = JSON.stringify(batch(['isolated-listener-comment']));
    const request = { method: 'POST' as const, url: '/integrations/instagram/webhook', payload: raw,
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=' + createHmac('sha256', secret).update(raw).digest('hex') } };
    try {
      expect((await isolated.inject({ ...request, headers: { 'content-type': 'application/json' } })).statusCode).toBe(401);
      expect((await data.db.query("SELECT id FROM inbox_events WHERE provider_event_key='isolated-listener-comment'")).rowCount).toBe(0);
      expect((await isolated.inject(request)).json()).toEqual({ received: true, accepted: 1 });
      expect((await isolated.inject(request)).statusCode).toBe(200);
      expect((await data.db.query("SELECT id FROM inbox_events WHERE provider_event_key='isolated-listener-comment'")).rowCount).toBe(1);
      expect((await isolated.inject({ ...request, payload: 'x'.repeat(1024 * 1024 + 1) })).statusCode).toBe(413);
      const unsupported = await isolated.inject({ ...request, headers: { 'content-type': 'application/private-test' } });
      expect(unsupported.statusCode).toBe(415);
      expect(unsupported.body).not.toContain(raw);
      expect((await isolated.inject('/admin/connections')).statusCode).toBe(404);
      expect((await isolated.inject('/console')).statusCode).toBe(404);
    } finally {
      await isolated.close();
    }
  });

  it('uses the connected entry account, handles text and echo direction, and ignores unrelated accounts', async () => {
    const payload = { object: 'instagram', entry: [
      { id: account.accountId, time: Date.now(), messaging: [
        { sender: { id: 'customer' }, recipient: { id: account.accountId }, timestamp: Date.now(), message: { mid: 'email-message', text: 'person@example.com' } },
        { sender: { id: account.accountId }, recipient: { id: 'customer' }, timestamp: Date.now(), message: { mid: 'echo-message', text: 'Our reply', is_echo: true } },
        { sender: { id: 'intruder' }, recipient: { id: 'another-account' }, timestamp: Date.now(), message: { mid: 'wrong-recipient', text: 'ignored' } },
      ] },
      { id: 'unconnected-account', time: Date.now(), changes: [comment('unconnected-comment')] },
    ] };
    expect((await delivery(payload)).statusCode).toBe(200);
    const messages = (await data.db.query("SELECT provider_event_key,routing_outcome,participant_id FROM inbox_events WHERE event_type='message.received' ORDER BY provider_event_key")).rows;
    expect(messages).toEqual([
      { provider_event_key: 'echo-message', routing_outcome: 'ignored_self', participant_id: 'customer' },
      { provider_event_key: 'email-message', routing_outcome: null, participant_id: 'customer' },
    ]);
    expect((await data.db.query("SELECT id FROM inbox_events WHERE provider_event_key='unconnected-comment'")).rowCount).toBe(0);
  });

  it('retries a partially stored batch without duplicating earlier events', async () => {
    await data.db.query(`CREATE FUNCTION fail_one_event() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.provider_event_key='batch-two' THEN RAISE EXCEPTION 'injected storage outage'; END IF; RETURN NEW; END $$`);
    await data.db.query('CREATE TRIGGER fail_one_event BEFORE INSERT ON inbox_events FOR EACH ROW EXECUTE FUNCTION fail_one_event()');
    try {
      expect((await delivery(batch(['batch-one', 'batch-two']))).statusCode).toBe(500);
      expect((await data.db.query("SELECT id FROM inbox_events WHERE provider_event_key='batch-one'")).rowCount).toBe(1);
    } finally {
      await data.db.query('DROP TRIGGER fail_one_event ON inbox_events');
      await data.db.query('DROP FUNCTION fail_one_event()');
    }
    expect((await delivery(batch(['batch-one', 'batch-two']))).statusCode).toBe(200);
    expect((await data.db.query("SELECT id FROM inbox_events WHERE provider_event_key IN ('batch-one','batch-two')")).rowCount).toBe(2);
  });

  it('retains a signed STOP during token expiry and suppresses a new trigger after reconnect', async () => {
    await data.db.query("UPDATE instagram_credentials SET expires_at=now()-interval '1 minute' WHERE connection_id=$1", [account.connectionId]);
    await data.db.query("UPDATE social_connections SET status='unauthorized',verified_at=NULL WHERE id=$1", [account.connectionId]);
    const payload = { object: 'instagram', entry: [{ id: account.accountId, time: Date.now(), messaging: [
      { sender: { id: 'opted-out-customer' }, recipient: { id: account.accountId }, timestamp: Date.now(), message: { mid: 'stop-while-expired', text: 'STOP' } },
      { sender: { id: 'ignored-during-expiry' }, recipient: { id: account.accountId }, timestamp: Date.now(), message: { mid: 'ordinary-while-expired', text: 'hello' } },
    ] }] };
    expect((await delivery(payload)).statusCode).toBe(200);
    expect((await data.db.query("SELECT opted_out FROM conversations WHERE participant_id='opted-out-customer'")).rows[0].opted_out).toBe(true);
    expect((await data.db.query("SELECT id FROM inbox_events WHERE provider_event_key='ordinary-while-expired'")).rowCount).toBe(0);
    await data.db.query("UPDATE instagram_credentials SET expires_at=now()+interval '1 day',token_version=token_version+1 WHERE connection_id=$1", [account.connectionId]);
    await data.db.query("UPDATE social_connections SET status='active',verified_at=now() WHERE id=$1", [account.connectionId]);
    await createAutomation(data.db, { dispatchConfigured: true, integrationMode: 'native', tenantId: account.tenantId,
      connectionId: account.connectionId, name: 'Pricing', definition: pricingDefinition });
    const event = await ingestEvent({ db: data.db, clock: systemClock, source:'native' }, commentEvent({ accountId: account.accountId, from: 'opted-out-customer' }));
    if (event.status !== 'accepted') throw new Error('Trigger not stored');
    expect(await routeEvent({ db: data.db, clock: systemClock }, event.eventId)).toMatchObject({ outcome: 'opted_out', runId: null });
  });

  it('does not accept new events for a disconnected account', async () => {
    await data.db.query("UPDATE social_connections SET status='disconnected',verified_at=NULL WHERE id=$1", [account.connectionId]);
    expect((await delivery(batch(['after-disconnect']))).statusCode).toBe(200);
    expect((await data.db.query("SELECT id FROM inbox_events WHERE provider_event_key='after-disconnect'")).rowCount).toBe(0);
  });
});
