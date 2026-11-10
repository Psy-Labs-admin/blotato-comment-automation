import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../src/api/server';
import { systemClock } from '../../src/domain/clock';
import { createTestDb } from '../helpers/db';
import { commentEvent, dmEvent, seedTenant } from '../helpers/fixtures';
import { createTestAccess } from '../helpers/test-access';

describe('signed gateway input validation', () => {
  let data: Awaited<ReturnType<typeof createTestDb>>;
  let app: FastifyInstance;
  let account: Awaited<ReturnType<typeof seedTenant>>;
  const auth = createTestAccess();
  const delivery = (payload: unknown) => app.inject({ method: 'POST', url: '/webhooks/instagram', ...auth.signedWebhook(payload) });
  beforeAll(async () => {
    data = await createTestDb();
    account = await seedTenant(data.db);
    app = buildServer({ db: data.db, access: auth.access, integrationMode: 'gateway', clock: systemClock, logger: false });
  });
  afterAll(async () => { await app?.close(); await data?.drop(); });

  it('rejects PostgreSQL-incompatible text and identities before persistence', async () => {
    const base = commentEvent({ accountId: account.accountId, from: 'gateway-input-user' });
    for (const invalid of ['nul\u0000', 'high\ud800', 'low\udfff']) {
      for (const payload of [
        { ...base, text: invalid }, { ...base, commentId: invalid }, { ...base, mediaId: invalid },
        { ...base, accountId: invalid }, { ...base, from: { id: invalid } }, { ...base, from: { id: 'user', username: invalid } },
      ]) {
        expect((await delivery(payload)).statusCode).toBe(400);
      }
    }
    for (const id of ['\t', 'user\n', 'user\u0001']) {
      expect((await delivery({ ...base, from: { id } })).statusCode).toBe(400);
    }
    expect((await data.db.query('SELECT id FROM inbox_events')).rowCount).toBe(0);
    expect((await data.db.query('SELECT id FROM conversations')).rowCount).toBe(0);
  });

  it('retains legal Unicode, controls in text and exact size boundaries', async () => {
    const text = '😀世界\n\t\u0001' + 'x'.repeat(4994);
    expect(Array.from(text)).toHaveLength(5000);
    const payload = commentEvent({ accountId: account.accountId, from: 'gateway-unicode', text, commentId: 'c'.repeat(200) });
    expect((await delivery(payload)).statusCode).toBe(202);
    expect((await delivery(payload)).json()).toMatchObject({ duplicate: true });
    expect((await data.db.query('SELECT text FROM inbox_events WHERE provider_event_key=$1', [payload.commentId])).rows[0].text).toBe(text);
    expect((await delivery({ ...payload, commentId: 'c'.repeat(201) })).statusCode).toBe(400);
    expect((await delivery({ ...payload, text: text + 'x' })).statusCode).toBe(400);
  });

  it('does not interpret malformed senders or text as a STOP and retains valid STOP handling', async () => {
    for (const payload of [
      dmEvent({ accountId: account.accountId, from: ' stop-user ', text: 'STOP' }),
      dmEvent({ accountId: account.accountId, from: '\u0000stop-user', text: 'STOP' }),
      dmEvent({ accountId: account.accountId, from: 'stop-user', text: 'STOP\u0000' }),
      { ...dmEvent({ accountId: account.accountId, from: 'stop-user', text: 'STOP' }), occurredAt: 'not-a-date' },
    ]) expect((await delivery(payload)).statusCode).toBe(400);
    expect((await data.db.query("SELECT id FROM conversations WHERE participant_id='stop-user'")).rowCount).toBe(0);
    expect((await delivery(dmEvent({ accountId: account.accountId, from: 'stop-user', text: 'STOP' }))).statusCode).toBe(202);
    expect((await data.db.query("SELECT opted_out FROM conversations WHERE participant_id='stop-user'")).rows[0].opted_out).toBe(true);
  });

  it('rejects datetime values PostgreSQL cannot represent', async () => {
    const payload = commentEvent({ accountId: account.accountId, from: 'gateway-date-user' });
    for (const occurredAt of ['0000-01-01T00:00:00Z', '2026-11-10T12:00:00+16:00', '2026-11-10T12:00:00-23:59']) {
      expect((await delivery({ ...payload, occurredAt })).statusCode).toBe(400);
    }
    expect((await delivery({ ...payload, occurredAt: '2026-11-10T12:00:00+15:59' })).statusCode).toBe(202);
  });

  it('rejects malformed UTF-8 after verifying the original signed bytes', async () => {
    const encoded = JSON.stringify(commentEvent({ accountId: account.accountId, from: 'corrupt-person' })).split('\"corrupt-person\"');
    const raw = Buffer.concat([Buffer.from(encoded[0] + '\"'), Buffer.from([0xff]), Buffer.from('\"' + encoded[1])]);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const response = await app.inject({ method: 'POST', url: '/webhooks/instagram', payload: raw, headers: {
      'content-type': 'application/json', 'x-webhook-timestamp': timestamp,
      'x-webhook-signature': 'sha256=' + createHmac('sha256', auth.webhookSecret).update(timestamp + '.').update(raw).digest('hex'),
    } });
    expect(response.statusCode).toBe(400);
  });

  it('enforces the gateway raw-body boundary before persistence', async () => {
    const payload = { ...commentEvent({ accountId: account.accountId, from: 'body-boundary-user' }), padding: '' };
    payload.padding = 'x'.repeat(65536 - Buffer.byteLength(JSON.stringify(payload)));
    const raw = JSON.stringify(payload);
    expect(Buffer.byteLength(raw)).toBe(65536);
    expect((await delivery(raw)).statusCode).toBe(202);
    expect((await delivery(raw + ' ')).statusCode).toBe(413);
  });

  it('returns a retryable error for genuine storage failure', async () => {
    await data.db.query(`CREATE FUNCTION fail_gateway_input() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.provider_event_key='gateway-storage-failure' THEN RAISE EXCEPTION 'injected outage'; END IF; RETURN NEW; END $$`);
    await data.db.query('CREATE TRIGGER fail_gateway_input BEFORE INSERT ON inbox_events FOR EACH ROW EXECUTE FUNCTION fail_gateway_input()');
    const payload = commentEvent({ accountId: account.accountId, from: 'gateway-storage-user', commentId: 'gateway-storage-failure' });
    try { expect((await delivery(payload)).statusCode).toBe(500); }
    finally {
      await data.db.query('DROP TRIGGER fail_gateway_input ON inbox_events');
      await data.db.query('DROP FUNCTION fail_gateway_input()');
    }
    expect((await delivery(payload)).statusCode).toBe(202);
  });
});
