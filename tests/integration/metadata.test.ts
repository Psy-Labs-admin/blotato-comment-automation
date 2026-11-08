import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb } from '../helpers/db';
import { commentEvent, createAutomation, seedTenant } from '../helpers/fixtures';
import { ingestEvent } from '../../src/ingest/ingest';
import { routeEvent } from '../../src/ingest/router';
import { systemClock } from '../../src/domain/clock';
import { startFakeInstagram, type FakeInstagram } from '../fixtures/providers/fake-instagram';
import { HttpMetadataClient } from '../../src/metadata/client';
import { metadataHandler } from '../../src/metadata/hydrate';
import type { OutboxRow } from '../../src/relay/relay';

describe('asynchronous post metadata cache', () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let fake: FakeInstagram;
  beforeAll(async () => { t = await createTestDb(); fake = await startFakeInstagram(); });
  afterAll(async () => { await fake?.close(); await t?.drop(); });

  async function enqueue(tenant: Awaited<ReturnType<typeof seedTenant>>, mediaId: string) {
    const result = await ingestEvent({ db: t.db, clock: systemClock }, commentEvent({ accountId: tenant.accountId, from: 'person', mediaId }));
    if (result.status !== 'accepted') throw new Error('ingest failed');
    const saved = (await t.db.query(`SELECT * FROM outbox WHERE idempotency_key = $1`, [`metadata:${result.eventId}`])).rows[0];
    const row: OutboxRow = { id: saved.id, tenantId: saved.tenant_id, kind: saved.kind, idempotencyKey: saved.idempotency_key,
      payload: saved.payload, attempts: 0 };
    return { eventId: result.eventId, row };
  }
  const cache = async (connectionId: string, mediaId: string) => (await t.db.query(
    `SELECT *, expires_at > now() AS fresh FROM post_metadata_cache WHERE connection_id = $1 AND media_id = $2`,
    [connectionId, mediaId],
  )).rows[0];

  it('accepts and routes the comment before metadata starts, caches success and refreshes after TTL', async () => {
    const tenant = await seedTenant(t.db);
    await createAutomation(t.db, tenant);
    const { eventId, row } = await enqueue(tenant, 'cached-post');
    expect((await routeEvent({ db: t.db, clock: systemClock }, eventId)).outcome).toBe('started');
    expect(fake.metadataRequests()).toHaveLength(0);
    const handler = metadataHandler({ db: t.db, client: new HttpMetadataClient(fake.url) });
    await handler(row);
    expect(await cache(tenant.connectionId, 'cached-post')).toMatchObject({ status: 'available', fresh: true, metadata: { caption: 'Demo post cached-post' } });
    await handler(row);
    expect(fake.metadataRequests()).toHaveLength(1);
    await t.db.query(`UPDATE post_metadata_cache SET expires_at = now() - interval '1 second' WHERE connection_id = $1`, [tenant.connectionId]);
    fake.setPostMetadata(tenant.accountId, 'cached-post', { status: 'available', metadata: { caption: 'Updated caption' } });
    await handler(row);
    expect(fake.metadataRequests()).toHaveLength(2);
    expect((await cache(tenant.connectionId, 'cached-post')).metadata.caption).toBe('Updated caption');
  });

  it.each(['denied', 'not_found'] as const)('caches negative %s results and isolates identical media IDs across tenants', async (status) => {
    const first = await seedTenant(t.db);
    const second = await seedTenant(t.db);
    const mediaId = `negative-${status}`;
    fake.setPostMetadata(first.accountId, mediaId, { status });
    const a = await enqueue(first, mediaId);
    const b = await enqueue(second, mediaId);
    const handler = metadataHandler({ db: t.db, client: new HttpMetadataClient(fake.url), negativeTtlSeconds: 60 });
    await handler(a.row);
    await handler(a.row);
    await handler(b.row);
    expect(await cache(first.connectionId, mediaId)).toMatchObject({ status, metadata: null, fresh: true });
    expect(await cache(second.connectionId, mediaId)).toMatchObject({ status: 'available', fresh: true });
    expect(fake.metadataRequests().filter((r) => r.mediaId === mediaId)).toHaveLength(2);
  });

  it('coalesces concurrent cache misses while an integration request is delayed', async () => {
    const tenant = await seedTenant(t.db);
    const { row } = await enqueue(tenant, 'slow-post');
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const handler = metadataHandler({ db: t.db, client: { fetchPost: async () => {
      calls += 1;
      entered();
      await blocked;
      return { status: 'available', metadata: { caption: 'slow' } };
    } } });
    const first = handler(row);
    await started;
    expect(await handler(row)).toMatchObject({ retryInMs: 500 });
    release();
    await first;
    expect(calls).toBe(1);
  });

  it('releases a failed cache refresh for retry without changing the accepted event', async () => {
    const tenant = await seedTenant(t.db);
    const { eventId, row } = await enqueue(tenant, 'error-post');
    const handler = metadataHandler({ db: t.db, client: { fetchPost: async () => { throw new Error('integration down'); } } });
    await expect(handler(row)).rejects.toThrow('integration down');
    expect(await cache(tenant.connectionId, 'error-post')).toMatchObject({ refresh_token: null, refreshing_until: null });
    expect((await t.db.query(`SELECT id FROM inbox_events WHERE id = $1`, [eventId])).rowCount).toBe(1);
  });
});
