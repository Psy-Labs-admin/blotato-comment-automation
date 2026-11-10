import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { Validator } from '@seriousme/openapi-schema-validator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance, HTTPMethods } from 'fastify';
import { buildServer } from '../../src/api/server';
import { createIntegrationKey } from '../helpers/integration-key';
import { systemClock } from '../../src/domain/clock';
import { createTestDb } from '../helpers/db';
import { commentEvent, seedTenant } from '../helpers/fixtures';
import { createTestAccess } from '../helpers/test-access';

const spec = JSON.parse(readFileSync(resolve(__dirname, '../../src/api/openapi.json'), 'utf8'));
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema({ $id: 'urn:blotato:contract', components: spec.components });
const schemaFor = (ref: string) => ajv.compile({ $ref: 'urn:blotato:contract' + ref });
function assertSchema(schema: object, value: unknown) {
  const validate = ajv.compile({ ...schema, components: spec.components });
  expect(validate(value), JSON.stringify(validate.errors)).toBe(true);
}

it('is a valid OpenAPI 3.1 document with unique operation IDs and resolvable JSON Schemas', async () => {
  const result = await new Validator().validate(spec);
  expect(result.valid, JSON.stringify(result.errors)).toBe(true);
  expect(spec.openapi).toBe('3.1.0');
  expect(spec.servers).toEqual([{ url: '/api/v1', description: 'Same-origin versioned public API' }]);
  const ids = Object.values(spec.paths).flatMap((path: any) =>
    Object.values(path).map((op: any) => op.operationId),
  );
  expect(ids).toHaveLength(15);
  expect(new Set(ids).size).toBe(ids.length);
  for (const name of Object.keys(spec.components.schemas)) schemaFor('#/components/schemas/' + name);
  for (const path of Object.values(spec.paths) as any[])
    for (const op of Object.values(path) as any[]) {
      const content = op.requestBody?.content?.['application/json'];
      if (content?.example !== undefined) assertSchema(content.schema, content.example);
    }
});

it('expresses strict draft replacement inputs, revision checks, and required nullable response fields', () => {
  const patch = schemaFor('#/components/schemas/UpdateDraft');
  expect(patch({ expectedRevision: 1, connectionId: null, content: {} })).toBe(true);
  expect(patch({ expectedRevision: 1, name: 'Привет 👩‍💻' })).toBe(true);
  expect(patch({ expectedRevision: 1, content: { keyword: 'pricing', allowKeywordTypos: true } })).toBe(true);
  for (const invalid of [
    {},
    { expectedRevision: 0 },
    { expectedRevision: 1, content: { typo: true } },
    { expectedRevision: 1, content: { allowKeywordTypos: 'true' } },
    { expectedRevision: 1, name: 'bad\u0000name' },
    { expectedRevision: 1, content: { postIds: ['bad\ud800id'] } },
    { expectedRevision: 1, unknown: true },
  ])
    expect(patch(invalid)).toBe(false);
  const run = schemaFor('#/components/schemas/Run');
  const value = {
    id: randomUUID(),
    automationId: randomUUID(),
    conversationId: randomUUID(),
    status: 'starting',
    statusReason: null,
    currentStep: null,
    createdAt: new Date().toISOString(),
    finishedAt: null,
  };
  expect(run(value)).toBe(true);
  const { finishedAt: _, ...missing } = value;
  expect(run(missing)).toBe(false);
});

describe('public API runtime responses match the published contract', () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let app: FastifyInstance;
  let tenant: Awaited<ReturnType<typeof seedTenant>>;
  let headers: Record<string, string>;
  let readHeaders: Record<string, string>;
  const auth = createTestAccess();
  const exercised = new Set<string>();

  beforeAll(async () => {
    t = await createTestDb();
    tenant = await seedTenant(t.db, { name: 'Contract test workspace' });
    headers = {
      authorization:
        'Bearer ' + (await createIntegrationKey(t.db, tenant.tenantId, 'Contract writer', 'write')).token,
    };
    readHeaders = {
      authorization:
        'Bearer ' + (await createIntegrationKey(t.db, tenant.tenantId, 'Contract reader', 'read')).token,
    };
    app = buildServer({
      db: t.db,
      access: auth.access,
      dispatchConfigured: true,
      integrationMode: 'gateway',
      clock: systemClock,
      logger: false,
    });
    await app.ready();
    for (const [path, methods] of Object.entries(spec.paths))
      for (const method of Object.keys(methods as object)) {
        expect(
          app.hasRoute({
            method: method.toUpperCase() as HTTPMethods,
            url: '/api/v1' + path.replaceAll('{id}', ':id'),
          }),
          method + ' ' + path,
        ).toBe(true);
      }
  });
  afterAll(async () => {
    await app?.close();
    await t?.drop();
  });

  async function request(
    method: HTTPMethods,
    path: string,
    url: string,
    payload?: object,
    status = 200,
    requestHeaders = headers,
  ) {
    const response = await app.inject({
      method,
      url: '/api/v1' + url,
      headers: requestHeaders,
      ...(payload === undefined ? {} : { payload }),
    });
    expect(response.statusCode, response.body).toBe(status);
    const operation = spec.paths[path][method.toLowerCase()];
    let definition = operation.responses[String(status)];
    expect(definition, 'Undocumented response status').toBeDefined();
    if (definition.$ref) definition = spec.components.responses[definition.$ref.split('/').at(-1)];
    assertSchema(definition.content['application/json'].schema, response.json());
    exercised.add(method + ' ' + path);
    return response.json();
  }

  it('validates real success and error payloads for every documented operation', async () => {
    await request('GET', '/workspace', '/workspace');
    await request('GET', '/accounts', '/accounts');
    const content = {
      keyword: 'pricing',
      allowKeywordTypos: true,
      publicReply: 'Check your messages.',
      emailPrompt: 'What is your email?',
      linkText: 'Your guide',
      linkUrl: 'https://example.com/guide',
      maxClarifications: 0,
    };
    const { draft } = await request(
      'POST',
      '/drafts',
      '/drafts',
      { name: 'Contract automation', connectionId: tenant.connectionId, content },
      201,
    );
    await request('GET', '/drafts', '/drafts?limit=1');
    await request('GET', '/drafts/{id}', '/drafts/' + draft.id);
    const updated = await request('PATCH', '/drafts/{id}', '/drafts/' + draft.id, {
      expectedRevision: 1,
      content,
    });
    const published = await request('POST', '/drafts/{id}/publish', '/drafts/' + draft.id + '/publish', {
      expectedRevision: updated.draft.revision,
    });
    await request('GET', '/automations', '/automations');
    await request('GET', '/automations/{id}', '/automations/' + published.automationId);
    await request('POST', '/automations/{id}/disable', '/automations/' + published.automationId + '/disable', {});
    await request('POST', '/automations/{id}/enable', '/automations/' + published.automationId + '/enable');
    const event = await app.inject({
      method: 'POST',
      url: '/webhooks/instagram',
      ...auth.signedWebhook(
        commentEvent({ accountId: tenant.accountId, from: 'contract_participant', text: 'prcing please' }),
      ),
    });
    expect(event.statusCode, event.body).toBe(202);
    const run = (
      await t.db.query('SELECT id, conversation_id, trigger_event_id FROM automation_runs WHERE tenant_id=$1', [
        tenant.tenantId,
      ])
    ).rows[0];
    expect(run).toBeDefined();
    await request('GET', '/runs', '/runs?needsReview=false&limit=1');
    await request('GET', '/runs/{id}', '/runs/' + run.id);
    await request('GET', '/runs/{id}/timeline', '/runs/' + run.id + '/timeline');
    await t.db.query(
      `INSERT INTO leads (tenant_id,connection_id,conversation_id,participant_id,run_id,source_event_id,email) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        tenant.tenantId,
        tenant.connectionId,
        run.conversation_id,
        'contract_participant',
        run.id,
        run.trigger_event_id,
        'contract@example.com',
      ],
    );
    await request('GET', '/leads', '/leads?limit=1');
    await request('GET', '/workspace', '/workspace', undefined, 401, {});
    const mismatch = await request('GET', '/workspace', '/workspace', undefined, 403, {
      ...headers,
      'x-tenant-id': randomUUID(),
    });
    expect(mismatch.code).toBe('TENANT_MISMATCH');
    await request('POST', '/drafts', '/drafts', { name: 'Forbidden' }, 403, readHeaders);
    await request('GET', '/runs', '/runs?limit=101', undefined, 400);
    await request('GET', '/drafts', '/drafts?cursor=' + randomUUID(), undefined, 400);
    await request('GET', '/drafts/{id}', '/drafts/' + randomUUID(), undefined, 404);
    await request('PATCH', '/drafts/{id}', '/drafts/' + draft.id, { expectedRevision: 1 }, 409);
    const expected = Object.entries(spec.paths).flatMap(([path, methods]) =>
      Object.keys(methods as object).map((method) => method.toUpperCase() + ' ' + path),
    );
    expect([...exercised].sort()).toEqual(expected.sort());
  });
});
