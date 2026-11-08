import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import path from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';
import { buildServer } from '../../src/api/server';
import { systemClock } from '../../src/domain/clock';
import { createTestDb } from '../helpers/db';
import { seedTenant } from '../helpers/fixtures';
import { startFakeInstagram } from '../fixtures/providers/fake-instagram';

interface ProcessHandle {
  child: ChildProcess;
  output(): string;
  exited: Promise<void>;
  stop(): Promise<void>;
}
const children: ProcessHandle[] = [];
let data: Awaited<ReturnType<typeof createTestDb>>;
let gateway: Awaited<ReturnType<typeof startFakeInstagram>>;
let baseEnv: NodeJS.ProcessEnv;
let apiUrl: string;
const metricsToken = randomBytes(32).toString('hex');
const digest = (token: string) => createHash('sha256').update(token).digest('hex');

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No ephemeral TCP port');
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return address.port;
}

function role(role: 'api' | 'worker' | 'relay', overrides: NodeJS.ProcessEnv = {}): ProcessHandle {
  let output = '';
  // Deliberately do not inherit .env, real credentials, tracing exporters or deployment settings.
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
    cwd: path.resolve(__dirname, '../..'),
    env: { ...baseEnv, ROLE: role, ...overrides },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const stream of [child.stdout, child.stderr])
    stream?.on('data', (bytes: Buffer) => {
      output = (output + bytes.toString()).slice(-20000);
    });
  const exited = new Promise<void>((resolve) => {
    child.once('error', (error) => {
      output += String(error);
      resolve();
    });
    child.once('exit', () => resolve());
  });
  const handle: ProcessHandle = {
    child,
    output: () => output,
    exited,
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill('SIGTERM');
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          exited,
          new Promise<void>((resolve) => {
            timer = setTimeout(() => {
              child.kill('SIGKILL');
              resolve();
            }, 10000);
          }),
        ]);
        await exited;
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
  };
  children.push(handle);
  return handle;
}

async function awaitReady(
  status: number,
  pipeline: string,
  processes: ProcessHandle[],
  timeout = 30000,
  targetUrl = apiUrl,
) {
  const deadline = Date.now() + timeout;
  let observed = 'no HTTP response';
  while (Date.now() < deadline) {
    for (const process of processes)
      if (process.child.exitCode !== null || process.child.signalCode !== null)
        throw new Error('Production role exited unexpectedly:\n' + process.output());
    try {
      const response = await fetch(targetUrl + '/ready', { signal: AbortSignal.timeout(1500) });
      const body = (await response.json()) as { pipeline?: string };
      observed = JSON.stringify({ status: response.status, ...body });
      if (response.status === status && body.pipeline === pipeline) return;
    } catch (error) {
      observed = String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(
    `Readiness did not reach ${status}/${pipeline}; last response ${observed}\n` +
      processes.map((p) => p.output()).join('\n'),
  );
}

beforeAll(async () => {
  data = await createTestDb();
  const tenant = await seedTenant(data.db);
  gateway = await startFakeInstagram();
  const port = await freePort();
  apiUrl = `http://127.0.0.1:${port}`;
  baseEnv = {
    PATH: process.env.PATH,
    TMPDIR: process.env.TMPDIR,
    DATABASE_URL: data.url,
    HOST: '127.0.0.1',
    PORT: String(port),
    LOG_LEVEL: 'error',
    DISPATCH_ENABLED: '1',
    TEMPORAL_ADDRESS: inject('temporalAddress'),
    TEMPORAL_NAMESPACE: 'default',
    TEMPORAL_TASK_QUEUE: 'role-health-' + randomUUID(),
    INSTAGRAM_BASE_URL: gateway.url,
    INSTAGRAM_API_TOKEN: randomBytes(32).toString('hex'),
    TENANT_TOKEN_HASHES: JSON.stringify({ [tenant.tenantId]: digest(randomBytes(32).toString('hex')) }),
    METRICS_TOKEN_HASH: digest(metricsToken),
    WEBHOOK_SIGNING_SECRET: randomBytes(32).toString('hex'),
  };
});
afterAll(async () => {
  for (const child of [...children].reverse()) await child.stop();
  await gateway?.close();
  await data?.drop();
});

it('runs the production API/worker/relay entrypoint and detects missing, ready and stopped replicas', async () => {
  const api = role('api');
  await awaitReady(503, 'attention', [api]);
  expect((await fetch(apiUrl + '/live')).status).toBe(200);
  expect((await fetch(apiUrl + '/health')).status).toBe(200);
  const worker = role('worker');
  const relay = role('relay');
  await awaitReady(200, 'ready', [api, worker, relay], 35000);
  const observations = await data.db.query(`SELECT role,state FROM service_heartbeats WHERE task_queue=$1`, [
    baseEnv.TEMPORAL_TASK_QUEUE,
  ]);
  expect(observations.rows).toEqual(
    expect.arrayContaining([
      { role: 'worker', state: 'ready' },
      { role: 'relay', state: 'ready' },
    ]),
  );
  // A second API expects optional consumers that the real relay did not start.
  const splitPort = await freePort();
  const splitApi = role('api', {
    PORT: String(splitPort),
    CRM_BASE_URL: gateway.url,
    CRM_API_TOKEN: randomBytes(32).toString('hex'),
    TELEGRAM_BOT_TOKEN: '123456:isolated-test-token-not-used',
    TELEGRAM_CHAT_ID: '1',
  });
  const splitUrl = `http://127.0.0.1:${splitPort}`;
  await awaitReady(503, 'attention', [splitApi, worker, relay], 10000, splitUrl);
  const splitMetrics = await fetch(splitUrl + '/metrics', {
    headers: { authorization: 'Bearer ' + metricsToken },
  });
  expect(splitMetrics.status).toBe(200);
  const metricsText = await splitMetrics.text();
  for (const kind of ['crm.lead_captured', 'alert.notify']) {
    expect(metricsText).toContain(`delivery_destination_configured{kind="${kind}"} 1`);
    expect(metricsText).toContain(`delivery_consumer_observed{kind="${kind}"} 0`);
  }
  expect(metricsText).toContain('service_role_ready{role="relay"} 0');
  // No notification consumer ran and no request used the test-only Telegram token.
  expect((await data.db.query('SELECT count(*)::int AS n FROM alert_deliveries')).rows[0].n).toBe(0);
  expect((await fetch(apiUrl + '/ready')).status).toBe(200);
  await splitApi.stop();
  // Prove shutdown is visible before TTL expiry, without fabricating heartbeat rows.
  await worker.stop();
  await awaitReady(503, 'attention', [api, relay]);
  expect((await fetch(apiUrl + '/health')).status).toBe(200);
  expect((await fetch(apiUrl + '/live')).status).toBe(200);
  expect(
    (
      await data.db.query(`SELECT state FROM service_heartbeats WHERE task_queue=$1 AND role='worker'`, [
        baseEnv.TEMPORAL_TASK_QUEUE,
      ])
    ).rows[0].state,
  ).toBe('stopping');
}, 60000);

it('keeps liveness independent of a closed DB pool while health and readiness fail honestly', async () => {
  const db = new Pool({ connectionString: data.url, max: 1 });
  const app = buildServer({
    db,
    clock: systemClock,
    logger: false,
    dispatchConfigured: true,
    operations: { namespace: 'default', taskQueue: baseEnv.TEMPORAL_TASK_QUEUE },
    access: {
      tenants: new Map(),
      metricsDigest: digest('test-only'),
      webhookSecret: 'isolated-test-secret-with-sufficient-length',
    },
  });
  try {
    expect((await app.inject('/health')).statusCode).toBe(200);
    await db.end();
    expect((await app.inject('/live')).statusCode).toBe(200);
    expect((await app.inject('/health')).statusCode).toBe(503);
    expect((await app.inject('/ready')).statusCode).toBe(503);
  } finally {
    await app.close();
  }
});
