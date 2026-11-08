import { createHmac, randomUUID } from 'node:crypto';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../src/api/server';
import { systemClock } from '../../src/domain/clock';
import { createTestDb } from '../helpers/db';
import { createTestAccess } from '../helpers/test-access';
import { commentEvent, seedTenant } from '../helpers/fixtures';

describe('HTTP trust boundaries', () => {
  let data: Awaited<ReturnType<typeof createTestDb>>;
  let app: FastifyInstance;
  let tenant: Awaited<ReturnType<typeof seedTenant>>;
  const auth = createTestAccess();
  beforeAll(async () => {
    data = await createTestDb();
    tenant = await seedTenant(data.db);
    app = buildServer({ db: data.db, clock: systemClock, logger: false, access: auth.access, dispatchConfigured: true, integrationMode: 'gateway' });
  });
  afterAll(async () => { await app?.close(); await data?.drop(); });

  it('gets tenant identity from the verified token and isolates monitoring', async () => {
    const headers = auth.operatorHeaders(tenant.tenantId);
    expect((await app.inject({ url: '/runs', headers })).statusCode).toBe(200);
    expect((await app.inject({ url: '/runs', headers: { 'x-tenant-id': tenant.tenantId } })).statusCode).toBe(401);
    expect((await app.inject({ url: '/runs', headers: { ...headers, 'x-tenant-id': randomUUID() } })).statusCode).toBe(401);
    expect((await app.inject({ url: '/metrics', headers })).statusCode).toBe(401);
    expect((await app.inject({ url: '/metrics', headers: auth.metricsHeaders })).statusCode).toBe(200);
    expect((await app.inject({ url: '/demo/workspace', headers })).statusCode).toBe(404);
    expect((await app.inject({ url: '/funnel?since=typo', headers })).statusCode).toBe(400);
  });

  it('requires the signature of the exact bytes and a recent delivery timestamp', async () => {
    const event = commentEvent({ accountId: tenant.accountId, from: 'test-person' });
    const raw = JSON.stringify(event, null, 2);
    const ts = String(Math.floor(Date.now() / 1000));
    const signature = (stamp: string) => 'sha256=' + createHmac('sha256', auth.webhookSecret).update(stamp + '.' + raw).digest('hex');
    const post = (stamp: string, sig: string, body: string) => app.inject({
      method: 'POST', url: '/webhooks/instagram', payload: body,
      headers: { 'content-type': 'application/json', 'x-webhook-timestamp': stamp, 'x-webhook-signature': sig },
    });
    expect((await post(ts, '', raw)).statusCode).toBe(401);
    expect((await post(ts, signature(ts), raw + ' ')).statusCode).toBe(401);
    const old = String(Number(ts) - 600);
    expect((await post(old, signature(old), raw)).statusCode).toBe(401);
    expect((await data.db.query('SELECT id FROM inbox_events')).rowCount).toBe(0);
    expect((await post(ts, signature(ts), raw)).statusCode).toBe(202);
    expect((await post(ts, signature(ts), raw)).json().duplicate).toBe(true);
  });

  it('rejects signed gateway events for a native account before creating any inbox or opt-out state', async () => {
    const native = await seedTenant(data.db, {name:'Native binding'});
    await data.db.query("UPDATE social_connections SET integration_kind='native' WHERE id=$1", [native.connectionId]);
    const inputs = [
      commentEvent({accountId:native.accountId,from:'participant'}),
      {type:'message.received', accountId:native.accountId, messageId:'stop', from:{id:'participant'}, text:'STOP',occurredAt:new Date().toISOString()},
    ];
    for (const input of inputs) expect((await app.inject({method:'POST',url:'/webhooks/instagram', ...auth.signedWebhook(input)})).statusCode).toBe(404);
    expect((await data.db.query('SELECT id FROM inbox_events WHERE connection_id=$1', [native.connectionId])).rowCount).toBe(0);
    expect((await data.db.query('SELECT id FROM conversations WHERE connection_id=$1', [native.connectionId])).rowCount).toBe(0);
  });

  it('rejects account IDs or tenant IDs as substitutes for access credentials', async () => {
    expect((await app.inject({ url: '/runs', headers: { 'x-tenant-id': tenant.tenantId, 'x-account-id': tenant.accountId } })).statusCode).toBe(401);
    expect((await app.inject({ url: '/runs', headers: { authorization: 'Bearer ' + tenant.tenantId } })).statusCode).toBe(401);
  });
});
