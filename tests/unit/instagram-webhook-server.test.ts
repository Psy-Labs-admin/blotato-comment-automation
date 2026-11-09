import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createInstagramWebhookServer, loadInstagramWebhookServerConfig } from '../../src/instagram/webhook-server';

const verifyToken = 'generated-verification-token-for-test';
const verification = (challenge = 'challenge-123', token = verifyToken, mode = 'subscribe') =>
  '/integrations/instagram/webhook?' + new URLSearchParams({ 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge });

describe('isolated Instagram verification listener', () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => { await app?.close(); });

  it('requires only a verification token and defaults to IPv4 loopback', async () => {
    const config = loadInstagramWebhookServerConfig({ INSTAGRAM_WEBHOOK_VERIFY_TOKEN: verifyToken, DATABASE_URL: 'not-used' });
    expect(config).toEqual({ host: '127.0.0.1', port: 3001, verifyToken, appSecret: undefined, databaseUrl: undefined });
    app = createInstagramWebhookServer(config);
    const response = await app.inject(verification());
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('challenge-123');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['content-type']).toMatch(/^text\/plain/);
  });

  it('checks method, mode, token, and bounded nonempty challenge', async () => {
    app = createInstagramWebhookServer(loadInstagramWebhookServerConfig({ INSTAGRAM_WEBHOOK_VERIFY_TOKEN: verifyToken }));
    for (const path of [verification('', verifyToken), verification('x'.repeat(1025)), verification('ok', 'wrong'), verification('ok', verifyToken, 'other'),
      verification() + '&hub.verify_token=duplicate']) {
      expect((await app.inject(path)).statusCode).toBe(403);
    }
    expect((await app.inject(verification('x'.repeat(1024)))).statusCode).toBe(200);
    for (const method of ['HEAD', 'PUT', 'DELETE', 'OPTIONS'] as const) {
      expect((await app.inject({ method, url: verification() })).statusCode).toBe(404);
    }
  });

  it('rejects every POST before body parsing in verification-only mode', async () => {
    app = createInstagramWebhookServer(loadInstagramWebhookServerConfig({ INSTAGRAM_WEBHOOK_VERIFY_TOKEN: verifyToken }));
    let parsed = false;
    app.addContentTypeParser('application/provider-test', (_req, _payload, done) => { parsed = true; done(null, {}); });
    for (const [type, payload] of [['application/provider-test', 'private-body'], ['application/json', '{invalid'], ['application/json', 'x'.repeat(1024 * 1024 + 1)]]) {
      expect((await app.inject({ method: 'POST', url: '/integrations/instagram/webhook', headers: { 'content-type': type }, payload })).statusCode).toBe(503);
    }
    expect(parsed).toBe(false);
  });

  it('exposes no console, admin, sessions, OAuth, or alternate webhook paths', async () => {
    app = createInstagramWebhookServer(loadInstagramWebhookServerConfig({ INSTAGRAM_WEBHOOK_VERIFY_TOKEN: verifyToken }));
    for (const url of ['/console', '/admin', '/admin/connections', '/session', '/health', '/metrics', '/integrations/instagram/callback', '/integrations/instagram/webhook/', '/integrations/instagram/webhook/extra']) {
      expect((await app.inject(url)).statusCode).toBe(404);
    }
  });

  it('validates startup configuration without requiring OAuth credentials', () => {
    const base = { INSTAGRAM_WEBHOOK_VERIFY_TOKEN: verifyToken };
    for (const env of [{}, { ...base, HOST: '0.0.0.0' }, { ...base, HOST: 'example.com' }, { ...base, PORT: '0' }, { ...base, PORT: '65536' }, { ...base, META_APP_SECRET: 'short' }, { ...base, META_APP_SECRET: verifyToken }, { ...base, META_APP_SECRET: 'a-real-signing-secret' }, { ...base, META_APP_SECRET: 'a-real-signing-secret', DATABASE_URL: 'invalid' }]) {
      expect(() => loadInstagramWebhookServerConfig(env)).toThrow();
    }
    expect(loadInstagramWebhookServerConfig({ ...base, META_APP_SECRET: 'a-real-signing-secret', DATABASE_URL: 'postgres://localhost/test', PORT: '3201' }).port).toBe(3201);
  });
});
