import Fastify, { type FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { systemClock } from '../domain/clock';
import { createPool } from '../storage/db';
import { registerInstagramWebhook, registerInstagramWebhookVerification } from './webhook';

export interface InstagramWebhookServerConfig {
  host: string;
  port: number;
  verifyToken: string;
  appSecret?: string;
  databaseUrl?: string;
}

/** This listener needs webhook credentials only; Instagram Login/session settings are unrelated. */
export function loadInstagramWebhookServerConfig(env: NodeJS.ProcessEnv = process.env): InstagramWebhookServerConfig {
  const host = env.HOST?.trim() || '127.0.0.1';
  if (!['127.0.0.1', '::1', 'localhost'].includes(host)) throw new Error('HOST must be loopback');
  const port = Number(env.PORT ?? 3001);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
  const verifyToken = env.INSTAGRAM_WEBHOOK_VERIFY_TOKEN?.trim() || '';
  if (verifyToken.length < 16 || verifyToken.length > 1024 || /\s/.test(verifyToken)) {
    throw new Error('INSTAGRAM_WEBHOOK_VERIFY_TOKEN must contain 16 to 1024 characters without whitespace');
  }
  const appSecret = env.META_APP_SECRET?.trim() || undefined;
  if (appSecret && (appSecret.length < 16 || /\s/.test(appSecret) || appSecret === verifyToken)) {
    throw new Error('META_APP_SECRET must contain at least 16 characters and differ from the verification token');
  }
  let databaseUrl: string | undefined;
  if (appSecret) {
    databaseUrl = env.DATABASE_URL?.trim();
    if (!databaseUrl) throw new Error('DATABASE_URL is required for authenticated webhook ingestion');
    let database: URL;
    try { database = new URL(databaseUrl); } catch { throw new Error('DATABASE_URL must be a PostgreSQL connection URL'); }
    if (!['postgres:', 'postgresql:'].includes(database.protocol)) throw new Error('DATABASE_URL must be a PostgreSQL connection URL');
  }
  return { host, port, verifyToken, appSecret, databaseUrl };
}

/** Never registers console, admin, OAuth, health, session, or dispatch routes. */
export function createInstagramWebhookServer(config: InstagramWebhookServerConfig, db?: Pool): FastifyInstance {
  const app = Fastify({ logger: false, exposeHeadRoutes: false, forceCloseConnections: true, bodyLimit: 1024 * 1024 });
  if (config.appSecret) {
    if (!db && !config.databaseUrl) throw new Error('DATABASE_URL is required for authenticated webhook ingestion');
    const pool = db ?? createPool(config.databaseUrl!);
    if (!db) app.addHook('onClose', async () => pool.end());
    registerInstagramWebhook(app, { db: pool, clock: systemClock, appSecret: config.appSecret, verifyToken: config.verifyToken });
  } else {
    registerInstagramWebhookVerification(app, config.verifyToken);
    app.post('/integrations/instagram/webhook', {
      // Reject before Fastify reads, parses, or retains any provider body.
      onRequest: async (_req, reply) => reply.code(503).header('Cache-Control', 'no-store').send({ error: 'Webhook ingestion is not configured' }),
    }, async (_req, reply) => reply.code(503).send());
  }
  // Exceptions may contain database details; never serialize them or log provider requests.
  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: 'Not found' }));
  app.setErrorHandler((error, _req, reply) => {
    const code = typeof error === 'object' && error !== null && 'statusCode' in error ? error.statusCode : undefined;
    const status = typeof code === 'number' && code >= 400 && code < 500 ? code : 500;
    return reply.code(status).send({ error: 'Webhook request failed' });
  });
  return app;
}

export async function startInstagramWebhookServer(env: NodeJS.ProcessEnv = process.env): Promise<FastifyInstance> {
  const config = loadInstagramWebhookServerConfig(env);
  const app = createInstagramWebhookServer(config);
  try {
    await app.listen({ host: config.host, port: config.port });
  } catch (error) {
    await app.close();
    throw error;
  }
  return app;
}

if (require.main === module) {
  void startInstagramWebhookServer().then((app) => {
    console.log('Instagram webhook listener ready (loopback only)');
    const stop = () => { void app.close().catch(() => { process.exitCode = 1; }); };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  }).catch(() => {
    console.error('Instagram webhook listener could not start; check webhook environment settings and port availability');
    process.exitCode = 1;
  });
}
