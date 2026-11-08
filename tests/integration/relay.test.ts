import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createTestDb } from '../helpers/db';
import { OutboxRelay, type OutboxRow } from '../../src/relay/relay';
import { enqueueOutbox } from '../../src/storage/outbox';
import { withTx } from '../../src/storage/db';

describe('outbox relay', () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: Pool;
  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
  });
  afterAll(async () => t?.drop());

  const enqueue = (key: string, kind: any = 'alert.notify') =>
    withTx(db, (c) => enqueueOutbox(c, { tenantId: null, kind, idempotencyKey: key, payload: { key } }));
  const row = async (key: string) => (await db.query(`SELECT * FROM outbox WHERE idempotency_key = $1`, [key])).rows[0];
  const fast = { backoff: () => 0, pollMs: 10 };

  it('enqueueing the same idempotency key twice stores one row', async () => {
    expect(await enqueue('dup')).toBe(true);
    expect(await enqueue('dup')).toBe(false);
    await db.query(`DELETE FROM outbox`);
  });

  it('two relays draining concurrently deliver every row exactly once', async () => {
    for (let i = 0; i < 50; i++) await enqueue(`row-${i}`);
    const seen = new Map<string, number>();
    const handler = async (r: OutboxRow) => {
      await new Promise((res) => setTimeout(res, 2));
      seen.set(r.idempotencyKey, (seen.get(r.idempotencyKey) ?? 0) + 1);
    };
    const mk = () => new OutboxRelay({ db, kinds: ['alert.notify'], handlers: { 'alert.notify': handler }, batchSize: 7, ...fast });
    const a = mk();
    const b = mk();
    while ((await Promise.all([a.drainOnce(), b.drainOnce()])).some((n) => n > 0));
    expect(seen.size).toBe(50);
    expect([...seen.values()].every((n) => n === 1)).toBe(true);
    expect(Number((await db.query(`SELECT count(*) n FROM outbox WHERE status = 'done'`)).rows[0].n)).toBe(50);
  });

  it('retries a failing handler with backoff and marks it done on success', async () => {
    await enqueue('flaky');
    let calls = 0;
    const relay = new OutboxRelay({
      db, kinds: ['alert.notify'], ...fast,
      handlers: { 'alert.notify': async () => { if (++calls < 3) throw new Error(`boom ${calls}`); } },
    });
    for (let i = 0; i < 5; i++) await relay.drainOnce();
    expect(calls).toBe(3);
    expect(await row('flaky')).toMatchObject({ status: 'done', attempts: 3 });
  });

  it('dead-letters after maxAttempts and calls onDead', async () => {
    await enqueue('poison', 'crm.lead_captured');
    const dead: string[] = [];
    const relay = new OutboxRelay({
      db, kinds: ['crm.lead_captured'], maxAttempts: 3, ...fast,
      handlers: { 'crm.lead_captured': async () => { throw new Error('always'); } },
      onDead: async (_c, r) => { dead.push(r.idempotencyKey); },
    });
    for (let i = 0; i < 6; i++) await relay.drainOnce();
    expect(await row('poison')).toMatchObject({ status: 'dead', attempts: 3, last_error: 'Error: always' });
    expect(dead).toEqual(['poison']);
  });

  it('a handler asking to retry later is rescheduled without burning an attempt', async () => {
    await enqueue('later', 'workflow.signal');
    let calls = 0;
    const relay = new OutboxRelay({
      db, kinds: ['workflow.signal'], maxAttempts: 1, ...fast,
      handlers: { 'workflow.signal': async () => (++calls < 3 ? { retryInMs: 0, reason: 'not started' } : undefined) },
    });
    for (let i = 0; i < 5; i++) await relay.drainOnce();
    expect(calls).toBe(3);
    expect(await row('later')).toMatchObject({ status: 'done' });
  });

  it('reclaims a row whose lease expired (relay crashed mid-delivery)', async () => {
    await enqueue('orphan', 'workflow.start');
    await db.query(`UPDATE outbox SET locked_until = now() - interval '1 second' WHERE idempotency_key = 'orphan'`);
    const got: string[] = [];
    const relay = new OutboxRelay({ db, kinds: ['workflow.start'], ...fast, handlers: { 'workflow.start': async (r) => { got.push(r.idempotencyKey); } } });
    await relay.drainOnce();
    expect(got).toEqual(['orphan']);
  });

  it.each(['retry', 'dead', 'defer'] as const)('fences a stale %s result after a newer relay completes', async (result) => {
    const key = `stale-${result}`;
    await enqueue(key, 'workflow.signal');
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let deadCalls = 0;
    const old = new OutboxRelay({
      db, kinds: ['workflow.signal'], maxAttempts: result === 'dead' ? 1 : 5, ...fast,
      handlers: { 'workflow.signal': async () => {
        entered();
        await blocked;
        if (result === 'defer') return { retryInMs: 0, reason: 'stale' };
        throw new Error('stale');
      } },
      onDead: async () => { deadCalls += 1; },
    });
    const first = old.drainOnce();
    await started;
    await db.query(`UPDATE outbox SET locked_until = now() - interval '1 second' WHERE idempotency_key = $1`, [key]);
    const current = new OutboxRelay({
      db, kinds: ['workflow.signal'], ...fast, handlers: { 'workflow.signal': async () => {} },
    });
    await current.drainOnce();
    release();
    await first;
    expect(await row(key)).toMatchObject({ status: 'done', attempts: 1, last_error: null });
    expect(deadCalls).toBe(0);
  });

  it('does not touch a row whose lease is still held', async () => {
    await enqueue('held', 'workflow.start');
    await db.query(`UPDATE outbox SET locked_until = now() + interval '1 minute' WHERE idempotency_key = 'held'`);
    const relay = new OutboxRelay({ db, kinds: ['workflow.start'], ...fast, handlers: { 'workflow.start': async () => {} } });
    expect(await relay.drainOnce()).toBe(0);
  });
});

describe('alert claim ordering', () => {
  let data: Awaited<ReturnType<typeof createTestDb>>;
  beforeAll(async () => { data = await createTestDb(); });
  afterAll(async () => data?.drop());
  it('blocks only later alerts for the same tenant/incident across backoff and concurrent claims', async () => {
    const a = (await data.db.query("INSERT INTO tenants(name) VALUES('isolated-a') RETURNING id")).rows[0].id;
    const b = (await data.db.query("INSERT INTO tenants(name) VALUES('isolated-b') RETURNING id")).rows[0].id;
    async function add(tenant: string, incidentId: string, label: string, delayed = false) {
      await withTx(data.db, c => enqueueOutbox(c, { tenantId: tenant, kind: 'alert.notify', idempotencyKey: label, payload: { incidentId, kind: 'opened' } }));
      if (delayed) await data.db.query("UPDATE outbox SET next_attempt_at=now()+interval '1 minute' WHERE idempotency_key=$1", [label]);
    }
    await add(a, 'incident-one', 'first', true);
    await add(a, 'incident-one', 'later');
    await add(a, 'incident-two', 'other-incident');
    await add(b, 'incident-one', 'other-tenant');
    const seen: string[] = [];
    let release!: () => void; let enter!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const handler = async (r: OutboxRow) => {
      seen.push(r.idempotencyKey);
      if (r.idempotencyKey === 'first') { enter(); await blocked; }
    };
    const make = () => new OutboxRelay({ db: data.db, kinds: ['alert.notify'], handlers: { 'alert.notify': handler } });
    expect(await make().drainOnce()).toBe(2);
    expect(seen.sort()).toEqual(['other-incident', 'other-tenant']);
    expect(await make().drainOnce()).toBe(0);
    await data.db.query("UPDATE outbox SET next_attempt_at=now() WHERE idempotency_key='first'");
    const first = make().drainOnce(); await entered;
    try {
      expect(await make().drainOnce()).toBe(0);
      expect(seen).not.toContain('later');
    } finally { release(); await first; }
    expect(await make().drainOnce()).toBe(1);
    expect(seen.at(-1)).toBe('later');
  });
});
