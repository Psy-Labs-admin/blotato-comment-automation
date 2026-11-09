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
