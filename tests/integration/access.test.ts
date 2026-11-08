import { createHash, createHmac, randomUUID } from 'node:crypto';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../src/api/server';
import { loadAccess } from '../../src/api/access';
import { systemClock } from '../../src/domain/clock';
import { createTestDb } from '../helpers/db';
import { commentEvent, seedTenant } from '../helpers/fixtures';

describe('HTTP trust boundaries', () => {
  let data: Awaited<ReturnType<typeof createTestDb>>;
  let app: FastifyInstance;
  let demo: FastifyInstance;
  let tenant: Awaited<ReturnType<typeof seedTenant>>;
  const secret = 'test-only-webhook-signing-secret-is-long-enough';
  const hash = (s: string) => createHash('sha256').update(s).digest('hex');
  beforeAll(async () => {
    data = await createTestDb();
    tenant = await seedTenant(data.db);
    const access = loadAccess({
      TENANT_TOKEN_HASHES: JSON.stringify({ [tenant.tenantId]: hash('operator') }),
      METRICS_TOKEN_HASH: hash('monitor'), WEBHOOK_SIGNING_SECRET: secret,
    });
    const deps = { db: data.db, clock: systemClock, logger: false };
    app = buildServer({ ...deps, access });
    demo = buildServer(deps);
  });
  afterAll(async () => { await app?.close(); await demo?.close(); await data?.drop(); });

  it('gets tenant identity from the verified token and isolates monitoring', async () => {
    const headers = { authorization: 'Bearer operator' };
    expect((await app.inject({ url: '/runs', headers })).statusCode).toBe(200);
    expect((await app.inject({ url: '/runs', headers: { 'x-tenant-id': tenant.tenantId } })).statusCode).toBe(401);
    expect((await app.inject({ url: '/runs', headers: { ...headers, 'x-tenant-id': randomUUID() } })).statusCode).toBe(401);
    expect((await app.inject({ url: '/metrics', headers })).statusCode).toBe(401);
    expect((await app.inject({ url: '/metrics', headers: { authorization: 'Bearer monitor' } })).statusCode).toBe(200);
    expect((await app.inject({ url: '/demo/workspace', headers })).statusCode).toBe(404);
    expect((await app.inject({ url: '/funnel?since=typo', headers })).statusCode).toBe(400);
  });

  it('requires the signature of the exact bytes and a recent delivery timestamp', async () => {
    const event = commentEvent({ accountId: tenant.accountId, from: 'test-person' });
    const raw = JSON.stringify(event, null, 2);
    const ts = String(Math.floor(Date.now() / 1000));
    const signature = (stamp: string) => 'sha256=' + createHmac('sha256', secret).update(stamp + '.' + raw).digest('hex');
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

  it('rejects a foreign Host or browser Origin on the local demo', async () => {
    expect((await demo.inject({ url: '/health', headers: { host: 'malicious.example' } })).statusCode).toBe(403);
    expect((await demo.inject({ url: '/runs', headers: { host: 'localhost', origin: 'https://malicious.example', 'x-tenant-id': tenant.tenantId } })).statusCode).toBe(403);
  });
});
