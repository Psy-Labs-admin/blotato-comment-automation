import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb } from '../helpers/db';
import { seedTenant, commentEvent } from '../helpers/fixtures';
import { ingestEvent } from '../../src/ingest/ingest';
import { systemClock } from '../../src/domain/clock';
import { registerOperations } from '../../src/api/operations';
import { withTx } from '../../src/storage/db';
import { raiseIncident } from '../../src/alerts/incidents';
import { integrationHandlers, onDeadLetter } from '../../src/relay/integrations';
import { startServiceHeartbeat } from '../../src/observability/heartbeat';
import { OutboxRelay } from '../../src/relay/relay';

describe('atomic dead-letter condition', () => {
  let data: Awaited<ReturnType<typeof createTestDb>>;
  let consumer: Awaited<ReturnType<typeof startServiceHeartbeat>>;
  const app = Fastify();
  beforeAll(async () => {
    data = await createTestDb();
    consumer = await startServiceHeartbeat({
      db: data.db,
      role: 'relay',
      namespace: 'default',
      taskQueue: 'comment-automations',
      capabilities: ['dispatch', 'metadata'],
      probe: async () => true,
    });
    registerOperations(
      app,
      { db: data.db, dispatchConfigured: true, destinations: { metadata: true, crm: false, alerts: false } },
      (req) => req.headers['x-tenant-id'] as string,
    );
  });
  afterAll(async () => {
    await app.close();
    await consumer?.stop();
    await data?.drop();
  });
  async function setup(count: number) {
    const owner = await seedTenant(data.db);
    const event = await ingestEvent(
      { db: data.db, clock: systemClock },
      commentEvent({ accountId: owner.accountId, from: 'race-test' }),
    );
    if (event.status !== 'accepted') throw Error('fixture ingest failed');
    const ids: string[] = [];
    for (let i = 0; i < count; i++)
      ids.push(
        (
          await data.db.query(
            "INSERT INTO outbox(tenant_id,kind,idempotency_key,payload,status) VALUES($1,'metadata.hydrate',$2,$3,'dead') RETURNING id::text",
            [owner.tenantId, randomUUID(), { eventId: event.eventId }],
          )
        ).rows[0].id,
      );
    await withTx(data.db, (c) => raiseIncident(c, { tenantId: owner.tenantId, errorClass: 'outbox_dead_letter' }));
    return { owner, ids, eventId: event.eventId };
  }
  const retry = (tenantId: string, id: string) =>
    app.inject({
      method: 'POST',
      url: `/operator/deliveries/${id}/retry`,
      headers: { 'x-tenant-id': tenantId },
      payload: { expectedGeneration: '0', note: 'Destination repaired' },
    });
  async function barrier(tenantId: string, work: () => Promise<unknown>) {
    const holder = await data.db.connect();
    let pending: Promise<unknown> | undefined;
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM tenants WHERE id=$1 FOR NO KEY UPDATE', [tenantId]);
      pending = work();
      const deadline = Date.now() + 10000;
      for (;;) {
        const waiting = await data.db.query(
          "SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT id FROM tenants WHERE id=%FOR NO KEY UPDATE%'",
        );
        if (waiting.rows[0].n >= 2) break;
        if (Date.now() > deadline) throw Error('Both condition changes must wait for the tenant lock');
        await new Promise((r) => setTimeout(r, 10));
      }
      await holder.query('COMMIT');
      await pending;
    } finally {
      await holder.query('ROLLBACK');
      await pending?.catch(() => {});
      holder.release();
    }
  }
  it('resolves the condition when two different final dead deliveries are retried concurrently', async () => {
    const { owner, ids } = await setup(2);
    let results: any;
    await barrier(owner.tenantId, async () => {
      results = await Promise.all(ids.map((id) => retry(owner.tenantId, id)));
    });
    expect(results.map((r: any) => r.statusCode)).toEqual([200, 200]);
    expect(
      (
        await data.db.query(
          "SELECT count(*)::int n FROM incidents WHERE tenant_id=$1 AND error_class='outbox_dead_letter' AND status='open'",
          [owner.tenantId],
        )
      ).rows[0].n,
    ).toBe(0);
  });
  it('keeps an open condition when a new dead delivery races recovery of the old final row', async () => {
    const { owner, ids, eventId } = await setup(1);
    const fresh = (
      await data.db.query(
        "INSERT INTO outbox(tenant_id,kind,idempotency_key,payload) VALUES($1,'metadata.hydrate',$2,$3) RETURNING id::text",
        [owner.tenantId, randomUUID(), { eventId }],
      )
    ).rows[0].id;
    const relay = new OutboxRelay({
      db: data.db,
      kinds: ['metadata.hydrate'],
      handlers: {
        'metadata.hydrate': async () => {
          throw Error('isolated transport failure');
        },
      },
      maxAttempts: 1,
      onDead: onDeadLetter,
    });
    let response: any;
    await barrier(owner.tenantId, async () => {
      [response] = await Promise.all([retry(owner.tenantId, ids[0]), relay.drainOnce()]);
    });
    expect(response.statusCode).toBe(200);
    expect((await data.db.query('SELECT status FROM outbox WHERE id=$1', [fresh])).rows[0].status).toBe('dead');
    expect(
      (
        await data.db.query(
          "SELECT count(*)::int n FROM incidents WHERE tenant_id=$1 AND error_class='outbox_dead_letter' AND status='open'",
          [owner.tenantId],
        )
      ).rows[0].n,
    ).toBe(1);
  });
  it.each([{ leadId: 'not-a-uuid' }, {}, null])(
    'commits malformed CRM terminal work %j and surfaces an incident without projecting a lead',
    async (payload) => {
      const owner = await seedTenant(data.db);
      let calls = 0;
      const id = (
        await data.db.query(
          "INSERT INTO outbox(tenant_id,kind,idempotency_key,payload) VALUES($1,'crm.lead_captured',$2,$3) RETURNING id::text",
          [owner.tenantId, randomUUID(), JSON.stringify(payload)],
        )
      ).rows[0].id;
      const handlers = integrationHandlers({
        db: data.db,
        crm: {
          upsertLead: async () => {
            calls++;
          },
        },
      });
      const relay = new OutboxRelay({ db: data.db, kinds: ['crm.lead_captured'], handlers, onDead: onDeadLetter });
      await relay.drainOnce();
      await relay.drainOnce();
      expect(calls).toBe(0);
      expect(
        (await data.db.query('SELECT status,attempts,last_error FROM outbox WHERE id=$1', [id])).rows[0],
      ).toEqual({ status: 'dead', attempts: 1, last_error: 'crm_scope_invalid' });
      expect(
        (
          await data.db.query(
            "SELECT occurrences FROM incidents WHERE tenant_id=$1 AND error_class='outbox_dead_letter' AND status='open'",
            [owner.tenantId],
          )
        ).rows[0].occurrences,
      ).toBe(1);
    },
  );
});
