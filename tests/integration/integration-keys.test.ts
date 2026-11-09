import { randomUUID, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTestDb } from '../helpers/db';
import { buildServer } from '../../src/api/server';
import { systemClock } from '../../src/domain/clock';
import { createTestAccess } from '../helpers/test-access';
import { integrationTokenHash, registerIntegrationAuth } from '../../src/api/integration-keys';

// Test-only issuer; production key creation belongs to the trusted administration CLI.
async function createIntegrationKey(
  db: Awaited<ReturnType<typeof createTestDb>>['db'],
  tenantId: string,
  name: string,
  scope: 'read' | 'write' = 'read',
) {
  const token = 'blt_' + randomBytes(32).toString('base64url');
  const result = await db.query(
    'INSERT INTO integration_keys(tenant_id,name,scope,token_hash) VALUES ($1,$2,$3,$4) RETURNING id',
    [tenantId, name, scope, integrationTokenHash(token)],
  );
  return { id: result.rows[0].id as string, token };
}

const execute = promisify(execFile);
let storage: Awaited<ReturnType<typeof createTestDb>>;
const tenant = randomUUID(),
  foreign = randomUUID();
const app = Fastify(),
  replica = Fastify();
let read: Awaited<ReturnType<typeof createIntegrationKey>>,
  write: Awaited<ReturnType<typeof createIntegrationKey>>;
beforeAll(async () => {
  storage = await createTestDb();
  await storage.db.query('INSERT INTO tenants(id,name) VALUES ($1,$2),($3,$4)', [
    tenant,
    'Owner',
    foreign,
    'Foreign',
  ]);
  read = await createIntegrationKey(storage.db, tenant, 'Reader');
  write = await createIntegrationKey(storage.db, tenant, 'Writer', 'write');
  for (const server of [app, replica]) {
    server.get('/unprotected', async () => ({ ok: true }));
    await server.register(
      async (v1) => {
        const identity = registerIntegrationAuth(v1, storage.db);
        v1.get('/identity', async (request) => identity(request));
        v1.post('/identity', async (request) => identity(request));
      },
      { prefix: '/api/v1' },
    );
    await server.ready();
  }
});
afterAll(async () => {
  await app.close();
  await replica.close();
  await storage?.drop();
});
const bearer = (token: string) => ({ authorization: 'Bearer ' + token });
it('stores digests, gives each named credential 256 random bits, and encapsulates authentication', async () => {
  expect(read.token).toMatch(/^blt_[A-Za-z0-9_-]{43}$/);
  const rows = await storage.db.query('SELECT * FROM integration_keys WHERE id=$1', [read.id]);
  expect(rows.rows[0]).toMatchObject({
    tenant_id: tenant,
    name: 'Reader',
    scope: 'read',
    token_hash: integrationTokenHash(read.token),
  });
  expect(JSON.stringify(rows.rows)).not.toContain(read.token);
  expect((await app.inject('/unprotected')).statusCode).toBe(200);
});
it('requires a machine bearer credential and never falls back to cookies or other tokens', async () => {
  for (const headers of [
    {},
    { cookie: 'operator_session=' + read.token },
    bearer('a'.repeat(64)),
    bearer('monitor-' + 'b'.repeat(64)),
    bearer('blt_' + 'c'.repeat(43)),
    { authorization: 'Bearer ' + read.token + ', Bearer ' + write.token },
    { authorization: 'Basic ' + read.token },
  ]) {
    const response = await app.inject({ url: '/api/v1/identity', headers });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: 'UNAUTHORIZED', error: expect.any(String) });
  }
});
it('reads tenant only from the bearer key and enforces read/write scopes', async () => {
  const response = await app.inject({
    url: '/api/v1/identity?tenantId=' + foreign,
    headers: { ...bearer(read.token), cookie: 'operator_session=foreign', 'x-tenant-id': tenant.toUpperCase() },
  });
  expect(response.json()).toEqual({ tenantId: tenant, scope: 'read' });
  const mismatch = await app.inject({
    url: '/api/v1/identity',
    headers: { ...bearer(read.token), 'x-tenant-id': foreign },
  });
  expect(mismatch.statusCode).toBe(403);
  expect(mismatch.json().code).toBe('TENANT_MISMATCH');
  expect(
    (await app.inject({ method: 'HEAD', url: '/api/v1/identity', headers: bearer(read.token) })).statusCode,
  ).toBe(200);
  const forbidden = await app.inject({
    method: 'POST',
    url: '/api/v1/identity',
    headers: bearer(read.token),
    payload: { tenantId: foreign },
  });
  expect(forbidden.statusCode).toBe(403);
  expect(forbidden.json().code).toBe('INSUFFICIENT_SCOPE');
  for (const method of ['GET', 'POST'] as const)
    expect((await app.inject({ method, url: '/api/v1/identity', headers: bearer(write.token) })).statusCode).toBe(
      200,
    );
});
it('observes revocation immediately on independently registered replicas', async () => {
  const key = await createIntegrationKey(storage.db, tenant, 'Revoked');
  for (const server of [app, replica])
    expect((await server.inject({ url: '/api/v1/identity', headers: bearer(key.token) })).statusCode).toBe(200);
  await storage.db.query('UPDATE integration_keys SET revoked_at=now() WHERE id=$1', [key.id]);
  for (const server of [app, replica])
    expect((await server.inject({ url: '/api/v1/identity', headers: bearer(key.token) })).statusCode).toBe(401);
});
it('CLI issues stdout-only secrets, lists safe metadata, and rejects foreign revocation', async () => {
  const env = { ...process.env, DATABASE_URL: storage.url, BLOTATO_TENANT_ID: tenant };
  const cli = (args: string[], overrides = {}) =>
    execute(process.execPath, ['scripts/api-key.cjs', ...args], { env: { ...env, ...overrides } });
  const created = await cli(['create', 'CLI reader']);
  expect(created.stdout.trim()).toMatch(/^blt_[A-Za-z0-9_-]{43}$/);
  expect(created.stderr).not.toContain(created.stdout.trim());
  const rows = JSON.parse((await cli(['list'])).stdout);
  const key = rows.find((row: { name: string }) => row.name === 'CLI reader');
  expect(Object.keys(key).sort()).toEqual(['id', 'name', 'scope', 'status']);
  expect(key.scope).toBe('read');
  await expect(cli(['revoke', key.id], { BLOTATO_TENANT_ID: foreign })).rejects.toThrow();
  expect((await app.inject({ url: '/api/v1/identity', headers: bearer(created.stdout.trim()) })).statusCode).toBe(
    200,
  );
  await cli(['revoke', key.id]);
  expect((await app.inject({ url: '/api/v1/identity', headers: bearer(created.stdout.trim()) })).statusCode).toBe(
    401,
  );
  await expect(cli(['create', 'wrong'], { BLOTATO_TENANT_ID: '' })).rejects.toThrow();
});
it('CLI honors the private local installation and validates its database binding', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'blotato-key-test-'));
  const operator = path.join(directory, 'operator');
  mkdirSync(operator);
  writeFileSync(path.join(operator, 'service.env'), 'DATABASE_URL=' + JSON.stringify(storage.url));
  writeFileSync(
    path.join(operator, 'credentials.json'),
    JSON.stringify({ id: tenant, database: integrationTokenHash(storage.url) }),
  );
  const env = { ...process.env, DATABASE_URL: '', BLOTATO_TENANT_ID: '', BLOTATO_LOCAL_DIR: directory };
  try {
    const result = await execute(process.execPath, ['scripts/api-key.cjs', 'create', 'Local writer', '--write'], {
      env,
    });
    expect(
      (await app.inject({ method: 'POST', url: '/api/v1/identity', headers: bearer(result.stdout.trim()) }))
        .statusCode,
    ).toBe(200);
    writeFileSync(
      path.join(operator, 'credentials.json'),
      JSON.stringify({ id: foreign, database: 'bad-binding' }),
    );
    await expect(execute(process.execPath, ['scripts/api-key.cjs', 'list'], { env })).rejects.toThrow();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it('keeps machine credentials separate from operator and monitoring authentication', async () => {
  const access = createTestAccess();
  const server = buildServer({ db: storage.db, clock: systemClock, logger: false, access: access.access });
  try {
    for (const key of [read, write]) {
      for (const url of ['/operator/overview', '/runs', '/metrics'])
        expect((await server.inject({ url, headers: bearer(key.token) })).statusCode).toBe(401);
    }
    for (const headers of [access.operatorHeaders(tenant), access.metricsHeaders])
      expect((await app.inject({ url: '/api/v1/identity', headers })).statusCode).toBe(401);
  } finally {
    await server.close();
  }
});
