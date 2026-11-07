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

  it('does not touch a row whose lease is still held', async () => {
    await enqueue('held', 'workflow.start');
    await db.query(`UPDATE outbox SET locked_until = now() + interval '1 minute' WHERE idempotency_key = 'held'`);
    const relay = new OutboxRelay({ db, kinds: ['workflow.start'], ...fast, handlers: { 'workflow.start': async () => {} } });
    expect(await relay.drainOnce()).toBe(0);
  });
});
