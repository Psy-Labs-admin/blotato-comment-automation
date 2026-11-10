import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createIntegrationKey } from '../helpers/integration-key';
import { registerPublicApi } from '../../src/api/v1';
import { systemClock } from '../../src/domain/clock';
import { ingestEvent } from '../../src/ingest/ingest';
import { routeEvent } from '../../src/ingest/router';
import { createTestDb } from '../helpers/db';
import { seedTenant, commentEvent, createAutomation } from '../helpers/fixtures';

const content = {
  keyword: 'pricing',
  publicReply: 'Check your messages.',
  emailPrompt: 'Your email?',
  linkUrl: 'https://example.com/pricing',
  maxClarifications: 0,
};
describe('supported public API', () => {
  let data: Awaited<ReturnType<typeof createTestDb>>;
  let app: FastifyInstance;
  let tenant: Awaited<ReturnType<typeof seedTenant>>;
  let other: Awaited<ReturnType<typeof seedTenant>>;
  let write: Record<string, string>;
  let read: Record<string, string>;
  let foreign: Record<string, string>;
  beforeAll(async () => {
    data = await createTestDb();
    tenant = await seedTenant(data.db);
    other = await seedTenant(data.db);
    const key = async (id: string, scope: 'read' | 'write') => ({
      authorization: 'Bearer ' + (await createIntegrationKey(data.db, id, 'API test', scope)).token,
    });
    write = await key(tenant.tenantId, 'write');
    read = await key(tenant.tenantId, 'read');
    foreign = await key(other.tenantId, 'write');
    app = Fastify();
    app.register(registerPublicApi, {
      prefix: '/api/v1',
      db: data.db,
      clock: systemClock,
      dispatchConfigured: true,
      integrationMode: 'gateway',
    });
    await app.ready();
  });
  afterAll(async () => {
    await app?.close();
    await data?.drop();
  });
  const get = (url: string, headers = read) => app.inject({ url: '/api/v1' + url, headers });
  const post = (url: string, payload: Record<string, unknown>, headers = write) =>
    app.inject({ method: 'POST', url: '/api/v1' + url, headers, payload });
  it('rejects unrepresentable draft text before reserving a retry key or changing a revision', async () => {
    const headers = { ...write, 'idempotency-key': randomUUID() };
    for (const body of [
      { name: 'copied\u0000name' },
      { name: 'broken\ud800' },
      { name: 'Greeting', content: { publicReply: 'reply\udc00' } },
      { name: 'Posts', content: { postIds: ['post\u0000id'] } },
    ]) {
      const response = await post('/drafts', body, headers);
      expect(response.statusCode).toBe(400);
      expect(response.json().code).toBe('invalid_request');
    }

    const saved = await post('/drafts', { name: 'Цена ☕️', content: { publicReply: 'Спасибо 👩‍💻' } }, headers);
    expect(saved.statusCode).toBe(201);
    const { draft } = saved.json();
    const invalidEdit = await app.inject({ method: 'PATCH', url: '/api/v1/drafts/' + draft.id, headers: write,
      payload: { expectedRevision: draft.revision, content: { keyword: 'bad\u0000keyword' } } });
    expect(invalidEdit.statusCode).toBe(400);
    expect((await get('/drafts/' + draft.id)).json().draft).toEqual(draft);
  });
  it('requires integration keys and rejects read-only mutation before accepting a body', async () => {
    for (const headers of [
      {},
      { authorization: 'Bearer operator-secret' },
      { cookie: 'session=operator' },
    ] as Record<string, string>[])
      expect((await get('/workspace', headers)).statusCode).toBe(401);
    expect((await post('/drafts', { name: 'Denied' }, read)).statusCode).toBe(403);
    expect((await get('/workspace')).json()).toEqual({ id: tenant.tenantId, name: expect.any(String) });
    expect((await get('/accounts')).json().accounts).toEqual([
      expect.objectContaining({ id: tenant.connectionId, canPublish: true }),
    ]);
  });
  it('creates and edits drafts with stale write protection and tenant isolation', async () => {
    const created = await post('/drafts', { name: 'First', content, connectionId: tenant.connectionId });
    expect(created.statusCode).toBe(201);
    const draft = created.json().draft;
    expect((await get('/drafts/' + draft.id)).json().draft).toEqual(draft);
    expect((await get('/drafts/' + draft.id, foreign)).statusCode).toBe(404);
    expect((await post('/drafts', { name: 'Cross tenant', connectionId: other.connectionId })).statusCode).toBe(
      404,
    );
    const edit = (headers = write) =>
      app.inject({
        method: 'PATCH',
        url: '/api/v1/drafts/' + draft.id,
        headers,
        payload: { expectedRevision: 1, name: 'Updated' },
      });
    expect((await edit(foreign)).statusCode).toBe(404);
    expect((await edit()).json().draft).toMatchObject({ revision: 2, name: 'Updated' });
    expect((await edit()).statusCode).toBe(409);
    expect((await post('/drafts/' + draft.id + '/publish', { expectedRevision: 1 })).statusCode).toBe(409);
    const first = await post('/drafts/' + draft.id + '/publish', { expectedRevision: 2 });
    expect(first.statusCode).toBe(200);
    expect((await post('/drafts/' + draft.id + '/publish', { expectedRevision: 2 })).json().versionId).toBe(
      first.json().versionId,
    );
    const id = first.json().automationId;
    expect((await post('/automations/' + id + '/disable', {})).json()).toEqual({ status: 'disabled' });
    expect((await post('/drafts/' + draft.id + '/publish', { expectedRevision: 2 })).json().draft.status).toBe(
      'paused',
    );
    expect((await get('/automations/' + id)).json().automation).toEqual({
      id,
      name: 'Updated',
      status: 'disabled',
      connectionId: tenant.connectionId,
      versionId: first.json().versionId,
      version: 1,
    });
    expect((await get('/automations/' + id, foreign)).statusCode).toBe(404);
    expect((await post('/automations/' + id + '/enable', {}, foreign)).statusCode).toBe(404);
    expect((await post('/automations/' + id + '/enable', {})).statusCode).toBe(200);
    expect(
      (await data.db.query('SELECT count(*)::int n FROM automation_runs WHERE tenant_id = $1', [tenant.tenantId]))
        .rows[0].n,
    ).toBe(0);
  });
  it('deduplicates simultaneous keyed creates across credentials and replays the original response after edits', async () => {
    const replacement = await createIntegrationKey(data.db, tenant.tenantId, 'Replacement', 'write');
    const key = randomUUID();
    const headers = { ...write, 'idempotency-key': key };
    const rotated = { authorization: 'Bearer ' + replacement.token, 'idempotency-key': key };
    const payload = { name: '  Retry safely  ', content, connectionId: tenant.connectionId.toUpperCase() };
    const replies = await Promise.all(Array.from({ length: 8 }, (_, i) => post('/drafts', payload, i % 2 ? headers : rotated)));
    expect(replies.map((r) => r.statusCode)).toEqual(Array(8).fill(201));
    const original = replies[0].json();
    for (const response of replies) expect(response.json()).toEqual(original);
    expect((await data.db.query('SELECT count(*)::int n FROM automation_drafts WHERE tenant_id=$1 AND name=$2',
      [tenant.tenantId, 'Retry safely'])).rows[0].n).toBe(1);
    const edit = await app.inject({ method: 'PATCH', url: '/api/v1/drafts/' + original.draft.id,
      headers: write, payload: { expectedRevision: 1, name: 'Changed since creation' } });
    expect(edit.statusCode).toBe(200);
    const replay = await post('/drafts', { connectionId: tenant.connectionId, content: { ...content }, name: 'Retry safely' }, headers);
    expect(replay.statusCode).toBe(201);
    expect(replay.json()).toEqual(original);
    expect((await post('/drafts', { ...payload, name: 'Different' }, headers)).json().code).toBe('idempotency_conflict');
    expect((await post('/drafts', { ...payload, name: 'Different' }, headers)).statusCode).toBe(409);
    expect((await post('/drafts', payload, { ...read, 'idempotency-key': key })).statusCode).toBe(403);
    await data.db.query('UPDATE integration_keys SET revoked_at=now() WHERE id=$1', [replacement.id]);
    expect((await post('/drafts', payload, rotated)).statusCode).toBe(401);
    expect((await post('/drafts', payload, headers)).json()).toEqual(original);
    const third = await createIntegrationKey(data.db, tenant.tenantId, 'New credential', 'write');
    expect((await post('/drafts', payload, { authorization: 'Bearer ' + third.token, 'idempotency-key': key })).json()).toEqual(original);
    expect((await post('/drafts', { name: 'Other workspace' }, { ...foreign, 'idempotency-key': key })).statusCode).toBe(201);
  });
  it('uses normalized equality, preserves array order, and leaves unkeyed creates independent', async () => {
    const headers = { ...write, 'idempotency-key': randomUUID() };
    const first = await post('/drafts', { name: ' Defaults ' }, headers);
    expect((await post('/drafts', { name: 'Defaults', content: {} }, headers)).json()).toEqual(first.json());
    for (const changed of [{ name: 'Defaults', content }, { name: 'Defaults', connectionId: tenant.connectionId }])
      expect((await post('/drafts', changed, headers)).statusCode).toBe(409);
    const ordered = { ...write, 'idempotency-key': randomUUID() };
    expect((await post('/drafts', { name: 'Order', content: { postIds: [' a ', 'b'] } }, ordered)).statusCode).toBe(201);
    expect((await post('/drafts', { content: { postIds: ['a', 'b'] }, name: 'Order' }, ordered)).statusCode).toBe(201);
    expect((await post('/drafts', { name: 'Order', content: { postIds: ['b', 'a'] } }, ordered)).statusCode).toBe(409);
    const one = await post('/drafts', { name: 'No key' });
    const two = await post('/drafts', { name: 'No key' });
    expect(one.statusCode).toBe(201);
    expect(two.statusCode).toBe(201);
    expect(one.json().draft.id).not.toBe(two.json().draft.id);
  });
  it('rejects ambiguous or oversized keys and rolls back failed keyed attempts atomically', async () => {
    for (const key of ['', ' ', 'a,b', 'a b', 'x'.repeat(129), 'é', '"quoted"'])
      expect((await post('/drafts', { name: 'Bad key' }, { ...write, 'idempotency-key': key })).statusCode).toBe(400);
    const duplicate = await app.inject({ method: 'POST', url: '/api/v1/drafts',
      headers: { ...write, 'idempotency-key': ['same', 'same'] }, payload: { name: 'Duplicate header' } });
    expect(duplicate.statusCode).toBe(400);
    const boundary = { ...write, 'idempotency-key': 'x'.repeat(128) };
    expect((await post('/drafts', { name: 'Boundary' }, boundary)).statusCode).toBe(201);
    const failed = { ...write, 'idempotency-key': randomUUID() };
    expect((await post('/drafts', { name: 'Invalid account', connectionId: other.connectionId }, failed)).statusCode).toBe(404);
    expect((await post('/drafts', { name: 'Valid after failure' }, failed)).statusCode).toBe(201);
    const rollbackKey = randomUUID();
    await data.db.query(`ALTER TABLE draft_create_requests ADD CONSTRAINT test_response_failure
      CHECK (response IS NULL OR response->'draft'->>'name' <> 'Forced rollback')`);
    try {
      expect((await post('/drafts', { name: 'Forced rollback' }, { ...write, 'idempotency-key': rollbackKey })).statusCode).toBe(500);
      expect((await data.db.query('SELECT 1 FROM automation_drafts WHERE name=$1', ['Forced rollback'])).rowCount).toBe(0);
      expect((await data.db.query('SELECT 1 FROM draft_create_requests WHERE idempotency_key=$1', [rollbackKey])).rowCount).toBe(0);
    } finally {
      await data.db.query('ALTER TABLE draft_create_requests DROP CONSTRAINT test_response_failure');
    }
    expect((await post('/drafts', { name: 'Forced rollback' }, { ...write, 'idempotency-key': rollbackKey })).statusCode).toBe(201);
    const race = { ...write, 'idempotency-key': randomUUID() };
    const results = await Promise.all(['Race one', 'Race two'].map((name) => post('/drafts', { name }, race)));
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409]);
    expect(results.find((r) => r.statusCode === 409)!.json().code).toBe('idempotency_conflict');
  });
  it('blocks unsafe publication and rejects invalid bodies and pagination', async () => {
    const incomplete = (await post('/drafts', { name: 'Incomplete' })).json().draft;
    expect((await post('/drafts/' + incomplete.id + '/publish', { expectedRevision: 1 })).statusCode).toBe(409);
    expect((await post('/drafts', { name: 'Bad', extra: true })).statusCode).toBe(400);
    for (const query of ['limit=0', 'limit=101', 'limit=1.5', 'limit=no', 'extra=true', 'cursor=invalid'])
      expect((await get('/drafts?' + query)).statusCode).toBe(400);
    const foreignDraft = (await post('/drafts', { name: 'Foreign' }, foreign)).json().draft;
    expect((await get('/drafts?cursor=' + foreignDraft.id)).statusCode).toBe(400);
    const created = (await post('/drafts', { name: 'Unsafe', content, connectionId: tenant.connectionId })).json()
      .draft;
    await data.db.query('UPDATE social_connections SET sends_paused=true WHERE id=$1', [tenant.connectionId]);
    expect((await post('/drafts/' + created.id + '/publish', { expectedRevision: 1 })).statusCode).toBe(409);
    await data.db.query('UPDATE social_connections SET sends_paused=false WHERE id=$1', [tenant.connectionId]);
  });
  it('paginates stable draft timestamps without missing or repeating rows', async () => {
    await data.db.query('UPDATE automation_drafts SET created_at = $2 WHERE tenant_id = $1', [
      tenant.tenantId,
      '2026-11-08T01:00:00.123456Z',
    ]);
    const ids: string[] = [];
    let cursor: string | null = null;
    do {
      const response = await get('/drafts?limit=1' + (cursor ? '&cursor=' + cursor : ''));
      expect(response.statusCode).toBe(200);
      const body = response.json();
      ids.push(...body.drafts.map((d: { id: string }) => d.id));
      cursor = body.nextCursor;
    } while (cursor);
    expect(ids.length).toBeGreaterThan(2);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(
      (
        await data.db.query(
          'SELECT id FROM automation_drafts WHERE tenant_id=$1 ORDER BY created_at DESC,id DESC',
          [tenant.tenantId],
        )
      ).rows.map((r) => r.id),
    );
  });
  it('returns populated run, timeline, lead and legacy automation DTOs with tenant boundaries', async () => {
    const fixture = await seedTenant(data.db);
    const headers = {
      authorization: 'Bearer ' + (await createIntegrationKey(data.db, fixture.tenantId, 'Outcomes', 'read')).token,
    };
    const legacy = await createAutomation(data.db, fixture);
    const deps = { db: data.db, clock: systemClock };
    const event = await ingestEvent(deps, commentEvent({ accountId: fixture.accountId, from: 'api-person' }));
    if (event.status !== 'accepted') throw new Error('Fixture ingestion failed');
    const routed = await routeEvent(deps, event.eventId);
    const runId = routed.runId!;
    const row = (await data.db.query('SELECT * FROM automation_runs WHERE id=$1', [runId])).rows[0];
    await data.db.query(
      `INSERT INTO leads(tenant_id,connection_id,conversation_id,participant_id,run_id,source_event_id,email)
      VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [
        fixture.tenantId,
        fixture.connectionId,
        row.conversation_id,
        'api-person',
        runId,
        event.eventId,
        'person@example.com',
      ],
    );
    const runs = (await get('/runs?limit=1&needsReview=false', headers)).json();
    expect(runs.runs).toEqual([
      {
        id: runId,
        automationId: legacy.automationId,
        conversationId: row.conversation_id,
        status: 'starting',
        statusReason: null,
        currentStep: null,
        createdAt: expect.any(String),
        finishedAt: null,
      },
    ]);
    expect((await get('/runs/' + runId, headers)).json()).toEqual({ run: runs.runs[0] });
    const timeline = await get('/runs/' + runId + '/timeline', headers);
    expect(timeline.statusCode).toBe(200);
    expect(timeline.json().entries.length).toBeGreaterThan(0);
    expect(timeline.json().entries[0]).toEqual(
      expect.objectContaining({
        at: expect.any(String),
        type: expect.any(String),
        text: expect.any(String),
        refs: expect.any(Object),
      }),
    );
    const leads = (await get('/leads', headers)).json();
    expect(leads.leads).toEqual([
      {
        id: expect.any(String),
        email: 'person@example.com',
        runId,
        conversationId: row.conversation_id,
        createdAt: expect.any(String),
        crmStatus: 'pending',
      },
    ]);
    expect((await get('/automations', headers)).json().automations).toEqual([
      expect.objectContaining({ id: legacy.automationId, version: 1 }),
    ]);
    for (const path of ['/runs/' + runId, '/runs/' + runId + '/timeline', '/automations/' + legacy.automationId])
      expect((await get(path)).statusCode).toBe(404);
    expect((await get('/leads?cursor=' + leads.leads[0].id)).statusCode).toBe(400);
    expect((await get('/runs?status=invalid')).statusCode).toBe(400);
    expect((await get('/runs?cursor=' + randomUUID())).statusCode).toBe(400);
    expect((await get('/runs?needsReview=true', headers)).json().runs).toEqual([]);
    await data.db.query(
      `INSERT INTO message_intents(tenant_id,run_id,step_id,action_no,connection_id,conversation_id,kind,target,body,fingerprint,status)
      VALUES($1,$2,'review',1,$3,$4,'dm','{}','Isolated test','test','unknown')`,
      [fixture.tenantId, runId, fixture.connectionId, row.conversation_id],
    );
    expect((await get('/runs?needsReview=true', headers)).json().runs).toHaveLength(1);
    expect((await get('/runs?needsReview=false', headers)).json().runs).toEqual([]);
    const second = await ingestEvent(
      deps,
      commentEvent({ accountId: fixture.accountId, from: 'second-api-person' }),
    );
    if (second.status !== 'accepted') throw new Error('Fixture ingestion failed');
    const secondRoute = await routeEvent(deps, second.eventId);
    const secondRow = (await data.db.query('SELECT * FROM automation_runs WHERE id=$1', [secondRoute.runId]))
      .rows[0];
    await data.db.query(
      `INSERT INTO leads(tenant_id,connection_id,conversation_id,participant_id,run_id,source_event_id,email)
      VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [
        fixture.tenantId,
        fixture.connectionId,
        secondRow.conversation_id,
        'second-api-person',
        secondRow.id,
        second.eventId,
        'second@example.com',
      ],
    );
    await createAutomation(data.db, fixture);
    for (const resource of ['runs', 'leads', 'automations']) {
      const firstPage = (await get('/' + resource + '?limit=1', headers)).json();
      expect(firstPage[resource]).toHaveLength(1);
      expect(firstPage.nextCursor).toBeTypeOf('string');
      const secondPage = (await get('/' + resource + '?limit=1&cursor=' + firstPage.nextCursor, headers)).json();
      expect(secondPage[resource]).toHaveLength(1);
      expect(secondPage.nextCursor).toBeNull();
      expect(secondPage[resource][0].id).not.toBe(firstPage[resource][0].id);
      expect((await get('/' + resource + '?cursor=' + firstPage.nextCursor)).statusCode).toBe(400);
    }
  });
});
