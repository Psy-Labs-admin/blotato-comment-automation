import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTestDb } from '../helpers/db';
import { seedTenant, createAutomation, commentEvent } from '../helpers/fixtures';
import { ingestEvent } from '../../src/ingest/ingest';
import { routeEvent } from '../../src/ingest/router';
import { executeSend } from '../../src/activities/send';
import { systemClock } from '../../src/domain/clock';
import { InstagramGraphPlatform } from '../../src/instagram/platform';
import { sendJson, startServer } from '../fixtures/providers/http';

let data: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => { data = await createTestDb(); });
afterAll(async () => data?.drop());

async function run(native: boolean) {
  const tenant = await seedTenant(data.db);
  await createAutomation(data.db, tenant);
  const event = await ingestEvent({ db: data.db, clock: systemClock }, commentEvent({ accountId: tenant.accountId, from: 'person' }));
  if (event.status !== 'accepted') throw new Error('Event not stored');
  const route = await routeEvent({ db: data.db, clock: systemClock }, event.eventId);
  if (native) await data.db.query(`INSERT INTO instagram_credentials(connection_id,tenant_id,encrypted_token,expires_at,refresh_after,granted_scopes)
    VALUES($1,$2,'unused-test-encryption',now()+interval '1 day',now()+interval '12 hours','{}')`, [tenant.connectionId, tenant.tenantId]);
  if (native) await data.db.query("UPDATE social_connections SET integration_kind='native' WHERE id=$1", [tenant.connectionId]);
  return { tenant, runId: route.runId! };
}

it('records an old unauthorized attempt without revoking a newer account credential', async () => {
  const { tenant, runId } = await run(true);
  let enter!: () => void;
  let finish!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const release = new Promise<void>((resolve) => { finish = resolve; });
  const server = await startServer(async (_req, res) => { enter(); await release; sendJson(res, 401, { error: { code: 190 } }); });
  const platform = new InstagramGraphPlatform({
    graphVersion: 'v26.0', graphBaseUrl: server.url,
    credentials: async (accountId) => {
      const row = (await data.db.query('SELECT token_version FROM instagram_credentials WHERE connection_id=$1', [tenant.connectionId])).rows[0];
      return { token: 'test-private-token', accountId, connectionId: tenant.connectionId, tenantId: tenant.tenantId, tokenVersion: row.token_version };
    },
  });
  try {
    const sending = executeSend({ db: data.db, clock: systemClock, integrationMode: 'native', platform }, { runId, stepId: 'public_reply', actionNo: 1 });
    await entered;
    const client = await data.db.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT id FROM social_connections WHERE id=$1 FOR NO KEY UPDATE', [tenant.connectionId]);
      await client.query('UPDATE instagram_credentials SET token_version=token_version+1 WHERE connection_id=$1', [tenant.connectionId]);
      await client.query('COMMIT');
    } finally { client.release(); }
    finish();
    expect(await sending).toMatchObject({ status: 'rejected', reason: 'provider_unauthorized' });
    expect((await data.db.query('SELECT status,sends_paused FROM social_connections WHERE id=$1', [tenant.connectionId])).rows[0]).toEqual({ status: 'active', sends_paused: false });
    expect((await data.db.query("SELECT id FROM incidents WHERE connection_id=$1 AND error_class='connection_unauthorized'", [tenant.connectionId])).rowCount).toBe(0);
  } finally { finish(); await server.close(); }
});

it('pauses the account when the unauthorized response belongs to its current credential', async () => {
  const { tenant, runId } = await run(true);
  const platform = { send: async () => ({ status: 'rejected', code: 'unauthorized', httpStatus: 401,
    credentialGeneration: { connectionId: tenant.connectionId, version: 1 } } as const) };
  expect(await executeSend({ db: data.db, clock: systemClock, integrationMode: 'native', platform }, { runId, stepId: 'public_reply', actionNo: 1 })).toMatchObject({ status: 'rejected' });
  expect((await data.db.query('SELECT status,sends_paused FROM social_connections WHERE id=$1', [tenant.connectionId])).rows[0]).toEqual({ status: 'unauthorized', sends_paused: true });
});

it('blocks existing runs when the worker delivery mode no longer matches their account binding', async () => {
  let requests = 0;
  const platform = { send: async () => { requests++; return { status: 'accepted', providerMessageId: 'never-sent', httpStatus: 200 } as const; } };
  for (const native of [false, true]) {
    const { runId } = await run(native);
    const result = await executeSend({ db: data.db, clock: systemClock, integrationMode: native ? 'gateway' : 'native', platform }, { runId, stepId: 'public_reply', actionNo: 1 });
    expect(result).toMatchObject({ status: 'blocked', reason: 'delivery_unconfigured' });
  }
  expect(requests).toBe(0);
});

it('labels unavailable credentials accurately and keeps the attempt safe to retry before any HTTP call', async () => {
  const { runId } = await run(true);
  let calls = 0;
  const platform = new InstagramGraphPlatform({
    graphVersion: 'v26.0', credentials: async () => { throw new Error('temporary token storage outage'); },
    fetch: async () => { calls++; throw new Error('unexpected request'); },
  });
  expect(await executeSend({ db: data.db, clock: systemClock, integrationMode: 'native', platform }, { runId, stepId: 'public_reply', actionNo: 1 }))
    .toMatchObject({ status: 'deferred', reason: 'credentials_unavailable' });
  expect(calls).toBe(0);
});
