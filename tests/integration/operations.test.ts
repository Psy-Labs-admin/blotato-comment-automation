import { createHmac, randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { beforeAll, afterAll, it, expect } from 'vitest';
import { registerInstagramWebhook } from '../../src/instagram/webhook';
import { registerOperations } from '../../src/api/operations';
import { readOperations, readPipelineHealth } from '../../src/observability/operations';
import { startServiceHeartbeat } from '../../src/observability/heartbeat';
import { createMetrics } from '../../src/observability/metrics';
import { OperatorError } from '../../src/storage/drafts';
import { createTestDb } from '../helpers/db';
import { seedTenant, commentEvent, createAutomation } from '../helpers/fixtures';
import { routeEvent } from '../../src/ingest/router';
import { ingestEvent } from '../../src/ingest/ingest';
import { systemClock } from '../../src/domain/clock';

let data: Awaited<ReturnType<typeof createTestDb>>;
let tenant: Awaited<ReturnType<typeof seedTenant>>;
let other: Awaited<ReturnType<typeof seedTenant>>;
let relay: Awaited<ReturnType<typeof startServiceHeartbeat>>;
const app = Fastify();
const config = { dispatchConfigured: true, destinations: { crm: true, alerts: false, metadata: true } };
const headers = () => ({ 'x-tenant-id': tenant.tenantId });
beforeAll(async () => {
  data = await createTestDb();
  relay = await startServiceHeartbeat({
    db: data.db,
    role: 'relay',
    namespace: 'default',
    taskQueue: 'comment-automations',
    capabilities: ['dispatch', 'crm', 'metadata'],
    probe: async () => true,
  });
  tenant = await seedTenant(data.db);
  other = await seedTenant(data.db);
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof OperatorError) return reply.code(err.status).send({ error: err.code });
    reply.send(err);
  });
  registerOperations(app, { db: data.db, ...config }, (req) => req.headers['x-tenant-id'] as string);
});
afterAll(async () => {
  await app.close();
  await relay?.stop();
  await data?.drop();
});

it('fences replay generations and tenants, preserves idempotency and records atomic recovery', async () => {
  const event = await ingestEvent(
    { db: data.db, clock: systemClock },
    commentEvent({ accountId: tenant.accountId, from: 'test-only' }),
  );
  expect(event.status).toBe('accepted');
  if (event.status !== 'accepted') throw Error();
  const id = (
    await data.db.query(
      `INSERT INTO outbox(tenant_id,kind,idempotency_key,payload,status,attempts,last_error)
 VALUES($1,'metadata.hydrate',$2,$3,'dead',8,'secret@example.com token') RETURNING id::text`,
      [tenant.tenantId, randomUUID(), { eventId: event.eventId }],
    )
  ).rows[0].id;
  const list = await app.inject({ url: '/operator/deliveries', headers: headers() });
  expect(list.statusCode).toBe(200);
  expect(list.body).not.toContain('secret@example.com');
  expect(list.json().deliveries.find((d: any) => d.id === id).canRetry).toBe(true);
  const request = (who = tenant.tenantId) =>
    app.inject({
      method: 'POST',
      url: `/operator/deliveries/${id}/retry`,
      headers: { 'x-tenant-id': who },
      payload: { expectedGeneration: '0', note: 'Destination restored' },
    });
  expect((await request(other.tenantId)).statusCode).toBe(404);
  expect((await request()).statusCode).toBe(200);
  await data.db.query(`UPDATE outbox SET status='dead',attempts=8 WHERE id=$1`, [id]);
  expect((await request()).statusCode).toBe(409);
  expect(
    (
      await data.db.query(
        `SELECT count(*)::int n FROM run_audit_events WHERE tenant_id=$1 AND type='delivery.retry_requested'`,
        [tenant.tenantId],
      )
    ).rows[0].n,
  ).toBe(1);
  expect(
    (await app.inject({ url: '/operator/deliveries?cursor=9999999999999999999', headers: headers() })).statusCode,
  ).toBe(400);
});

it('never offers blind social or stale notification retry; paginates safe factual incident history', async () => {
  for (const kind of ['workflow.start', 'workflow.signal', 'alert.notify'])
    await data.db.query(
      `INSERT INTO outbox(tenant_id,kind,idempotency_key,payload,status) VALUES($1,$2,$3,$4,'dead')`,
      [tenant.tenantId, kind, randomUUID(), { text: 'private-message', token: 'private-token' }],
    );
  const list = (await app.inject({ url: '/operator/deliveries', headers: headers() })).json();
  expect(list.deliveries.filter((d: any) => d.kind !== 'metadata.hydrate').every((d: any) => !d.canRetry)).toBe(
    true,
  );
  expect(JSON.stringify(list)).not.toContain('private-');
  const first = (
    await data.db.query(
      `INSERT INTO incidents(tenant_id,error_class,first_seen_at,last_seen_at) VALUES($1,'outbox_dead_letter',now()-interval '2 hours',now()-interval '1 hour') RETURNING id`,
      [tenant.tenantId],
    )
  ).rows[0].id;
  await data.db.query(
    `INSERT INTO incidents(tenant_id,error_class,status,resolved_at) VALUES($1,'connection_unauthorized','resolved',now()),($2,'send_outcome_unknown','open',null)`,
    [tenant.tenantId, other.tenantId],
  );
  const detail = await app.inject({ url: `/operator/incidents/${first}`, headers: headers() });
  expect(detail.json().history.map((h: any) => h.type)).toEqual(['opened', 'last_occurrence']);
  expect(
    (await app.inject({ url: `/operator/incidents/${first}`, headers: { 'x-tenant-id': other.tenantId } }))
      .statusCode,
  ).toBe(404);
  expect(
    (await app.inject({ url: '/operator/incidents?status=resolved&limit=1', headers: headers() })).json()
      .incidents,
  ).toHaveLength(1);
  const snapshot = (await app.inject({ url: '/operator/operations', headers: headers() })).json();
  expect(snapshot.notifications.configured).toBe(false);
  expect(snapshot.queues.find((q: any) => q.kind === 'alert.notify').configured).toBe(false);
});

it('reports actual fresh/degraded/stale/missing/disabled probes and survives rolling replicas', async () => {
  const cfg = { dispatchConfigured: true, namespace: 'isolated-test', taskQueue: 'test-queue' };
  expect((await readPipelineHealth(data.db, cfg)).roles.every((r) => r.state === 'missing')).toBe(true);
  const make = (ready: boolean) =>
    startServiceHeartbeat({
      db: data.db,
      role: 'worker',
      namespace: cfg.namespace,
      taskQueue: cfg.taskQueue,
      probe: async () => ready,
      intervalMs: 100000,
    });
  const degraded = await make(false);
  expect((await readPipelineHealth(data.db, cfg)).roles[0].state).toBe('degraded');
  const healthy = await make(true);
  expect((await readPipelineHealth(data.db, cfg)).roles[0].state).toBe('ready');
  await degraded.stop();
  expect((await readPipelineHealth(data.db, cfg)).roles[0].state).toBe('ready');
  await healthy.stop();
  expect((await readPipelineHealth(data.db, cfg)).roles[0].state).toBe('degraded');
  await data.db.query(
    `UPDATE service_heartbeats SET observed_at=now()-interval '46 seconds' WHERE temporal_namespace=$1`,
    [cfg.namespace],
  );
  expect((await readPipelineHealth(data.db, cfg)).roles[0].state).toBe('stale');
  expect((await readPipelineHealth(data.db, { ...cfg, dispatchConfigured: false })).state).toBe('disabled');
  const metrics = await createMetrics(data.db, cfg).registry.metrics();
  expect(metrics).toContain('service_role_ready{role="worker"} 0');
  expect(metrics).toContain('delivery_destination_configured{kind="crm.lead_captured"} 0');
});

it('counts native acceptance, deduplication, invalid callbacks, ignored accounts and storage errors without private labels', async () => {
  const account = await seedTenant(data.db);
  await data.db.query("UPDATE social_connections SET integration_kind='native' WHERE id=$1", [
    account.connectionId,
  ]);
  await data.db.query(
    `INSERT INTO instagram_credentials(connection_id,tenant_id,encrypted_token,expires_at,refresh_after,granted_scopes)
 VALUES($1,$2,'isolated-unused-secret',now()+interval '1 day',now()+interval '12 hours','{}')`,
    [account.connectionId, account.tenantId],
  );
  const native = Fastify();
  const metrics = createMetrics(data.db, config);
  const secret = 'isolated-test-secret';
  registerInstagramWebhook(native, {
    db: data.db,
    clock: systemClock,
    appSecret: secret,
    verifyToken: 'unused-test-token',
    metrics,
  });
  const send = (id: string, valid = true, accountId = account.accountId) => {
    const raw = JSON.stringify({
      object: 'instagram',
      entry: [
        {
          id: accountId,
          time: Date.now(),
          changes: [
            {
              field: 'comments',
              value: { id, text: 'private-message', from: { id: 'private-person' }, media: { id: 'post' } },
            },
          ],
        },
      ],
    });
    return native.inject({
      method: 'POST',
      url: '/integrations/instagram/webhook',
      payload: raw,
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256':
          'sha256=' +
          createHmac('sha256', valid ? secret : 'wrong')
            .update(raw)
            .digest('hex'),
      },
    });
  };
  try {
    expect((await send('one', false)).statusCode).toBe(401);
    expect((await send('one')).statusCode).toBe(200);
    expect((await send('one')).statusCode).toBe(200);
    expect((await send('one', true, 'unconnected')).statusCode).toBe(200);
    await data.db.query(
      `CREATE FUNCTION operations_fail_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.provider_event_key='broken' THEN RAISE EXCEPTION 'isolated fault'; END IF; RETURN NEW; END $$`,
    );
    await data.db.query(
      'CREATE TRIGGER operations_fail_event BEFORE INSERT ON inbox_events FOR EACH ROW EXECUTE FUNCTION operations_fail_event()',
    );
    try {
      expect((await send('broken')).statusCode).toBe(500);
    } finally {
      await data.db.query('DROP TRIGGER operations_fail_event ON inbox_events');
      await data.db.query('DROP FUNCTION operations_fail_event()');
    }
    const text = await metrics.registry.metrics();
    expect(text).toContain('instagram_webhook_events_total{type="comment.created",result="accepted"} 1');
    expect(text).toContain('instagram_webhook_events_total{type="comment.created",result="duplicate"} 1');
    for (const result of ['invalid', 'ignored', 'storage_error'])
      expect(text).toContain(`instagram_webhook_deliveries_total{result="${result}"} 1`);
    expect(text).not.toContain('private-');
    expect(text).not.toContain(account.tenantId);
  } finally {
    await native.close();
  }
});

it('allows one CRM recovery concurrently and refuses synced, missing and disabled destinations', async () => {
  const owner = await seedTenant(data.db);
  await createAutomation(data.db, owner);
  const event = await ingestEvent(
    { db: data.db, clock: systemClock },
    commentEvent({ accountId: owner.accountId, from: 'crm-test' }),
  );
  if (event.status !== 'accepted') throw Error('fixture ingest failed');
  const run = await routeEvent({ db: data.db, clock: systemClock }, event.eventId);
  const lead = (
    await data.db.query(
      `INSERT INTO leads(tenant_id,connection_id,conversation_id,participant_id,run_id,source_event_id,email)
 SELECT tenant_id,$2,conversation_id,'crm-test',id,trigger_event_id,'isolated@example.com' FROM automation_runs WHERE id=$1 RETURNING id`,
      [run.runId, owner.connectionId],
    )
  ).rows[0].id;
  const id = (
    await data.db.query(
      `INSERT INTO outbox(tenant_id,kind,idempotency_key,payload,status) VALUES($1,'crm.lead_captured',$2,$3,'dead') RETURNING id`,
      [owner.tenantId, randomUUID(), { leadId: lead }],
    )
  ).rows[0].id;
  const request = (server = app, generation = '0') =>
    server.inject({
      method: 'POST',
      url: `/operator/deliveries/${id}/retry`,
      headers: { 'x-tenant-id': owner.tenantId },
      payload: { expectedGeneration: generation, note: 'Connection restored' },
    });
  const disabled = Fastify();
  disabled.setErrorHandler((err, _req, reply) => {
    if (err instanceof OperatorError) return reply.code(err.status).send({ error: err.code });
    reply.send(err);
  });
  registerOperations(
    disabled,
    { db: data.db, dispatchConfigured: true, taskQueue: 'no-consumer' },
    () => owner.tenantId,
  );
  try {
    expect((await request(disabled)).statusCode).toBe(409);
  } finally {
    await disabled.close();
  }
  const results = await Promise.all([request(), request()]);
  expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
  await data.db.query("UPDATE outbox SET status='dead' WHERE id=$1", [id]);
  await data.db.query("UPDATE leads SET crm_status='synced' WHERE id=$1", [lead]);
  expect((await request(app, '1')).statusCode).toBe(409);
  const list = (
    await app.inject({ url: '/operator/deliveries', headers: { 'x-tenant-id': owner.tenantId } })
  ).json();
  expect(list.deliveries.find((d: any) => d.id === String(id)).canRetry).toBe(false);
  expect(JSON.stringify(list)).not.toContain('isolated@example.com');
});

it('separates API intent from actual relay consumers and scopes receipts to the current destination', async () => {
  const queue = 'split-' + randomUUID();
  const key = 'a'.repeat(64);
  const oldKey = 'b'.repeat(64);
  const cfg = {
    dispatchConfigured: true,
    taskQueue: queue,
    destinations: {
      crm: true,
      alerts: true,
      metadata: true,
      alertChannel: 'telegram' as const,
      alertDestinationKey: key,
    },
  };
  const worker = await startServiceHeartbeat({
    db: data.db,
    role: 'worker',
    namespace: 'default',
    taskQueue: queue,
    probe: async () => true,
  });
  const bareRelay = await startServiceHeartbeat({
    db: data.db,
    role: 'relay',
    namespace: 'default',
    taskQueue: queue,
    capabilities: ['dispatch'],
    probe: async () => true,
  });
  let capableRelay: Awaited<ReturnType<typeof startServiceHeartbeat>> | undefined;
  const scoped = Fastify();
  scoped.setErrorHandler((err, _req, reply) => {
    if (err instanceof OperatorError) return reply.code(err.status).send({ error: err.code });
    reply.send(err);
  });
  registerOperations(scoped, { db: data.db, ...cfg }, () => tenant.tenantId);
  try {
    const health = await readPipelineHealth(data.db, cfg);
    expect(health.state).toBe('attention');
    expect(health.roles.find((r) => r.role === 'relay')?.state).toBe('degraded');
    expect(health.missingConsumers).toEqual(
      expect.arrayContaining(['crm.lead_captured', 'alert.notify', 'metadata.hydrate']),
    );
    const snapshot = (await scoped.inject('/operator/operations')).json();
    expect(snapshot.queues.find((q: any) => q.kind === 'alert.notify')).toMatchObject({
      expected: true,
      configured: true,
      observed: false,
      state: 'unavailable',
    });
    expect(snapshot.notifications).toMatchObject({
      expected: true,
      configured: true,
      observed: false,
      lastAcceptedAt: null,
    });
    expect(JSON.stringify(snapshot)).not.toContain(key);
    const event = await ingestEvent(
      { db: data.db, clock: systemClock },
      commentEvent({ accountId: tenant.accountId, from: 'split-test' }),
    );
    if (event.status !== 'accepted') throw Error('fixture failed');
    const id = (
      await data.db.query(
        `INSERT INTO outbox(tenant_id,kind,idempotency_key,payload,status) VALUES($1,'metadata.hydrate',$2,$3,'dead') RETURNING id`,
        [tenant.tenantId, randomUUID(), { eventId: event.eventId }],
      )
    ).rows[0].id;
    expect(
      (
        await scoped.inject({
          method: 'POST',
          url: `/operator/deliveries/${id}/retry`,
          payload: { expectedGeneration: '0', note: 'Relay not configured' },
        })
      ).statusCode,
    ).toBe(409);
    const metrics = await createMetrics(data.db, cfg).registry.metrics();
    expect(metrics).toContain('delivery_destination_configured{kind="alert.notify"} 1');
    expect(metrics).toContain('delivery_consumer_observed{kind="alert.notify"} 0');
    capableRelay = await startServiceHeartbeat({
      db: data.db,
      role: 'relay',
      namespace: 'default',
      taskQueue: queue,
      capabilities: ['dispatch', 'crm', 'alerts', 'metadata', 'alert.telegram:' + key],
      probe: async () => true,
    });
    expect((await readPipelineHealth(data.db, cfg)).state).toBe('ready');
    const incident = (
      await data.db.query(
        `INSERT INTO incidents(tenant_id,error_class,status,resolved_at) VALUES($1,'outbox_dead_letter','resolved',now()) RETURNING id`,
        [tenant.tenantId],
      )
    ).rows[0].id;
    const outbox = (
      await data.db.query(
        `INSERT INTO outbox(tenant_id,kind,idempotency_key,payload,status) VALUES($1,'alert.notify',$2,$3,'done') RETURNING id`,
        [tenant.tenantId, randomUUID(), { incidentId: incident, kind: 'opened' }],
      )
    ).rows[0].id;
    await data.db.query(
      `INSERT INTO alert_deliveries(outbox_id,tenant_id,incident_id,channel,channel_key,status,attempts,accepted_at) VALUES($1,$2,$3,'telegram',$4,'accepted',1,now())`,
      [outbox, tenant.tenantId, incident, oldKey],
    );
    const current = await readOperations(data.db, tenant.tenantId, cfg);
    expect(current.notifications.lastAcceptedAt).toBeNull();
    expect(current.notifications.lastOutcome).toBeNull();
    await data.db.query('UPDATE alert_deliveries SET channel_key=$2 WHERE outbox_id=$1', [outbox, key]);
    expect((await readOperations(data.db, tenant.tenantId, cfg)).notifications.lastOutcome).toBe('accepted');
    expect(
      (
        await readOperations(data.db, tenant.tenantId, {
          ...cfg,
          destinations: { ...cfg.destinations, alertDestinationKey: oldKey },
        })
      ).notifications.lastOutcome,
    ).toBeNull();
    // A different expected destination remains unavailable even if another bot is healthy.
    const rotated = await readOperations(data.db, tenant.tenantId, {
      ...cfg,
      destinations: { ...cfg.destinations, alertDestinationKey: 'c'.repeat(64) },
    });
    expect(rotated.notifications).toMatchObject({
      expected: true,
      observed: false,
      lastAcceptedAt: null,
      lastOutcome: null,
    });
    expect(rotated.pipeline.state).toBe('attention');
  } finally {
    await scoped.close();
    await capableRelay?.stop();
    await bareRelay.stop();
    await worker.stop();
  }
});
