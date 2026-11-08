import { expect, it } from 'vitest';
import { createTracing } from '../../src/observability/tracing';
import { sendJson, startServer } from '../../src/fakes/http';
import { buildServer } from '../../src/api/server';
import { systemClock } from '../../src/domain/clock';
import { createTestDb } from '../helpers/db';
import { commentEvent, createAutomation, seedTenant } from '../helpers/fixtures';

it('exports real OTLP JSON spans with bounded attributes and nested parent context', async () => {
  const exports: Array<{ path: string; body: any }> = [];
  const collector = await startServer((_req, res, body, url) => {
    exports.push({ path: url.pathname, body });
    sendJson(res, 200, {});
  });
  const tracing = createTracing({ OTEL_EXPORTER_OTLP_ENDPOINT: `${collector.url}/collector`, ROLE: 'api' });
  try {
    const request = tracing.startRequest('POST');
    await request.run(() => tracing.withSpan('webhook.ingest', async () => tracing.withSpan('webhook.route', async () => 'done')));
    request.end(202, 'webhook');
    request.end(500, 'management'); // response hooks cannot export the same span twice
    await expect(tracing.withSpan('automation.send', async () => { throw new Error('private-email@example.com and bearer-secret'); })).rejects.toThrow('private-email');
    const unsafe = tracing.startRequest('GET /person/private-email@example.com');
    unsafe.end(500, 'private-email@example.com' as any);
    await tracing.flush();
    expect(exports.length).toBeGreaterThan(0);
    expect(exports.every((entry) => entry.path === '/collector/v1/traces')).toBe(true);
    const spans = exports.flatMap((entry) => entry.body.resourceSpans.flatMap((resource: any) => resource.scopeSpans.flatMap((scope: any) => scope.spans)));
    expect(spans).toHaveLength(5);
    const parent = spans.find((span) => span.name === 'webhook.ingest');
    const child = spans.find((span) => span.name === 'webhook.route');
    const http = spans.find((span) => span.name === 'http.request' && span.attributes.some((attribute: any) => attribute.key === 'http.response.status_code' && attribute.value.intValue === 202));
    expect(child.traceId).toBe(parent.traceId);
    expect(child.parentSpanId).toBe(parent.spanId);
    expect(parent.traceId).toBe(http.traceId);
    expect(parent.parentSpanId).toBe(http.spanId);
    const serialized = JSON.stringify(exports);
    expect(serialized).not.toContain('private-email');
    expect(serialized).not.toContain('bearer-secret');
    expect(serialized).not.toContain('exception.message');
  } finally {
    await tracing.shutdown();
    await collector.close();
  }
});

it('keeps tracing entirely disabled without an explicit endpoint', async () => {
  const tracing = createTracing({});
  expect(tracing.enabled).toBe(false);
  expect(await tracing.withSpan('webhook.ingest', async () => 42)).toBe(42);
  tracing.startRequest('POST').end(202, 'webhook');
  await tracing.flush();
  await tracing.shutdown();
});

it('honours OTEL_SDK_DISABLED without contacting a configured collector', async () => {
  let calls = 0;
  const collector = await startServer((_req, res) => { calls++; sendJson(res, 200, {}); });
  try {
    const tracing = createTracing({ OTEL_SDK_DISABLED: 'true', OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `${collector.url}/v1/traces` });
    await tracing.withSpan('webhook.route', async () => {});
    await tracing.flush();
    expect(tracing.enabled).toBe(false);
    expect(calls).toBe(0);
  } finally { await collector.close(); }
});

it('rejects unsupported exporter protocols before starting a collector connection', () => {
  expect(() => createTracing({ OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://127.0.0.1:4318/v1/traces', OTEL_EXPORTER_OTLP_PROTOCOL: 'grpc' })).toThrow('http/json');
});

it('exports one HTTP trace containing real webhook ingestion and routing spans', async () => {
  const database = await createTestDb();
  const exports: any[] = [];
  const collector = await startServer((_req, res, body) => { exports.push(body); sendJson(res, 200, {}); });
  const tracing = createTracing({ OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `${collector.url}/v1/traces` });
  const app = buildServer({ db: database.db, clock: systemClock, logger: false, tracing });
  try {
    const tenant = await seedTenant(database.db);
    await createAutomation(database.db, tenant);
    const url = await app.listen({ host: '127.0.0.1', port: 0 });
    const response = await fetch(`${url}/webhooks/instagram`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer private-token' },
      body: JSON.stringify(commentEvent({ accountId: tenant.accountId, from: 'private-person', text: 'pricing private-email@example.com' })),
    });
    expect(response.status).toBe(202);
    await response.json();
    await tracing.flush();
    const spans = exports.flatMap((entry) => entry.resourceSpans.flatMap((resource: any) => resource.scopeSpans.flatMap((scope: any) => scope.spans)));
    expect(spans.map((span) => span.name).sort()).toEqual(['http.request', 'webhook.ingest', 'webhook.route']);
    const http = spans.find((span) => span.name === 'http.request');
    for (const child of spans.filter((span) => span.name !== 'http.request')) {
      expect(child.traceId).toBe(http.traceId);
      expect(child.parentSpanId).toBe(http.spanId);
    }
    const serialized = JSON.stringify(exports);
    for (const value of ['private-token', 'private-person', 'private-email', tenant.tenantId, tenant.accountId]) expect(serialized).not.toContain(value);
  } finally {
    await app.close();
    await tracing.shutdown();
    await collector.close();
    await database.drop();
  }
});
