import { createTestAccess } from './test-access';
import { randomUUID } from 'node:crypto';
import { inject } from 'vitest';
import { Client, Connection } from '@temporalio/client';
import { NativeConnection } from '@temporalio/worker';
import type { Pool } from 'pg';
import { createTestDb } from './db';
import { commentEvent, createAutomation, dmEvent, seedTenant } from './fixtures';
import { pricingWith } from './definitions';
import { startFakeInstagram, type FakeInstagram } from '../fixtures/providers/fake-instagram';
import { startFakeCrm, type FakeCrm } from '../fixtures/providers/fake-crm';
import { startFakeAlertSink, type FakeAlertSink } from '../fixtures/providers/fake-alert-sink';
import { HttpInstagramAdapter } from '../../src/adapters/instagram';
import { HttpCrmClient } from '../../src/adapters/crm';
import { HttpAlertSink } from '../../src/adapters/alerts';
import { systemClock } from '../../src/domain/clock';
import type { Capabilities } from '../../src/domain/types';
import { ingestEvent } from '../../src/ingest/ingest';
import { routeEvent } from '../../src/ingest/router';
import { OutboxRelay } from '../../src/relay/relay';
import { temporalHandlers } from '../../src/temporal/handlers';
import { integrationHandlers, onDeadLetter } from '../../src/relay/integrations';
import type { RunningWorker } from '../../src/temporal/worker';
import { startTestWorker as startWorker } from './workflow-coverage';
import type { ActivityDeps, CrashHooks } from '../../src/activities/deps';
import { buildServer } from '../../src/api/server';

export interface HarnessOptions {
  capabilities?: Partial<Capabilities>;
  definition?: unknown;
  hooks?: CrashHooks;
  /** Instagram adapter timeout (how long before a slow response counts as "unknown"). */
  sendTimeoutMs?: number;
  /** How often a waiting/blocked workflow re-checks Postgres without a signal (production: minutes). */
  recheckMs?: number;
}

const TERMINAL = new Set(['completed', 'expired', 'cancelled', 'failed']);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Real system under test: fresh Postgres database, real Temporal server (own task queue), real
 * HTTP fakes, a worker and two relays (Temporal commands; CRM + alerts), wired like production.
 */
export async function createHarness(o: HarnessOptions = {}) {
  const dbh = await createTestDb();
  const db: Pool = dbh.db;
  const ig: FakeInstagram = await startFakeInstagram();
  const crm: FakeCrm = await startFakeCrm();
  const alerts: FakeAlertSink = await startFakeAlertSink();
  const address = inject('temporalAddress');
  const connection = await Connection.connect({ address });
  const client = new Client({ connection });
  const native = await NativeConnection.connect({ address });
  const taskQueue = `test-${randomUUID()}`;

  const hooks: CrashHooks = o.hooks ?? {};
  const poke = () => {
    temporalRelay.poke();
    integrationRelay.poke();
  };
  const deps: ActivityDeps = {
    db,
    integrationMode: 'gateway',
    clock: systemClock,
    platform: new HttpInstagramAdapter(ig.url, { timeoutMs: o.sendTimeoutMs ?? 1_000 }),
    hooks,
    onOutbox: poke,
  };
  const temporalRelay = new OutboxRelay({
    db, kinds: ['workflow.start', 'workflow.signal'], handlers: temporalHandlers({ client, db, taskQueue, recheckMs: o.recheckMs ?? 400 }),
    pollMs: 50, backoff: () => 100, maxAttempts: Number.POSITIVE_INFINITY, onDead: onDeadLetter,
  });
  const integrationRelay = new OutboxRelay({
    db, kinds: ['crm.lead_captured', 'alert.notify'],
    handlers: integrationHandlers({ db, crm: new HttpCrmClient(crm.url, { timeoutMs: 1_000 }), notifier: new HttpAlertSink(alerts.url) }),
    pollMs: 50, backoff: () => 150, maxAttempts: 50, onDead: onDeadLetter,
  });
  temporalRelay.start();
  integrationRelay.start();

  let worker: RunningWorker | undefined = await startWorker({ deps, connection: native, taskQueue });

  const tenant = await seedTenant(db, { capabilities: o.capabilities });
  const automation = await createAutomation(db, tenant, o.definition ?? pricingWith({ timeout: '30s' }));
  const routerDeps = { db, clock: systemClock, onOutbox: poke };
  const auth = createTestAccess();
  const api = buildServer({ db, access: auth.access, provisioningSecret: auth.provisioningSecret, dispatchConfigured: true, integrationMode: 'gateway', clock: systemClock, onOutbox: poke, logger: false });

  async function deliver(raw: unknown) {
    const res = await ingestEvent(routerDeps, raw);
    if (res.status !== 'accepted') throw new Error(`ingest rejected: ${res.reason}`);
    return routeEvent(routerDeps, res.eventId);
  }

  const h = {
    db, ig, crm, alerts, client, tenant, automation, taskQueue, hooks, deps, temporalRelay, integrationRelay, api,

    /** Calls the management API as this tenant. */
    request: async (method: 'GET' | 'POST', url: string, payload?: unknown) => {
      const res = await api.inject({ method, url, payload: payload as any, headers: auth.operatorHeaders(tenant.tenantId) });
      return { status: res.statusCode, body: res.body ? res.json() : undefined };
    },
    async provisionAccount(status: 'active' | 'unauthorized' | 'disconnected') {
      const account = (await db.query('SELECT capabilities, integration_revision FROM social_connections WHERE id = $1', [tenant.connectionId])).rows[0];
      const res = await api.inject({ method: 'POST', url: '/integrations/accounts', ...auth.signedIntegration({
        type: 'instagram.account.updated', eventId: randomUUID(), tenantId: tenant.tenantId,
        accountId: tenant.accountId, displayName: 'Test account', status, capabilities: account.capabilities,
        integrationRevision: Number(account.integration_revision) + 1, occurredAt: new Date().toISOString(),
      }) });
      return { status: res.statusCode, body: res.json() };
    },
    /** Messages the fake Instagram accepted that belong to this participant's conversation. */
    messagesFor: (participant: string, commentId?: string) =>
      ig.sent().filter((m) => m.recipientId === participant || (commentId !== undefined && m.commentId === commentId)),

    /** A comment webhook (inline routing, like the API). Returns the routing decision. */
    comment: (from: string, extra: Partial<Parameters<typeof commentEvent>[0]> = {}) =>
      deliver(commentEvent({ accountId: tenant.accountId, from, ...extra })),
    rawComment: (from: string, extra: Partial<Parameters<typeof commentEvent>[0]> = {}) =>
      commentEvent({ accountId: tenant.accountId, from, ...extra }),
    deliver,
    dm: (from: string, text: string, messageId?: string) => deliver(dmEvent({ accountId: tenant.accountId, from, text, messageId })),

    run: async (runId: string) => (await db.query(`SELECT * FROM automation_runs WHERE id = $1`, [runId])).rows[0],
    lead: async (runId: string) => (await db.query(`SELECT * FROM leads WHERE run_id = $1`, [runId])).rows[0],
    intents: async (runId: string) =>
      (await db.query(`SELECT * FROM message_intents WHERE run_id = $1 ORDER BY created_at`, [runId])).rows,
    wait: async (runId: string) => (await db.query(`SELECT * FROM input_waits WHERE run_id = $1`, [runId])).rows[0],
    conversationOf: async (runId: string) =>
      (await db.query(`SELECT c.* FROM conversations c JOIN automation_runs r ON r.conversation_id = c.id WHERE r.id = $1`, [runId])).rows[0],
    sentTo: (participant: string) => ig.sent().filter((m) => m.recipientId === participant || m.kind !== 'dm'),

    async waitFor<T>(fn: () => Promise<T | undefined | null | false>, timeoutMs = 20_000, label = 'condition'): Promise<T> {
      const until = Date.now() + timeoutMs;
      for (;;) {
        const v = await fn();
        if (v) return v as T;
        if (Date.now() > until) throw new Error(`timed out waiting for ${label}`);
        await sleep(50);
      }
    },
    /** Waits until the run reaches a terminal status (or `status` if given). */
    async waitForRun(runId: string, status?: string, timeoutMs = 25_000) {
      return h.waitFor(
        async () => {
          const r = await h.run(runId);
          return (status ? r?.status === status : TERMINAL.has(r?.status)) ? r : undefined;
        },
        timeoutMs,
        `run ${runId} to reach ${status ?? 'a terminal status'}`,
      );
    },
    async stopWorker() {
      await worker?.shutdown();
      worker = undefined;
    },
    async startWorker() {
      worker = await startWorker({ deps, connection: native, taskQueue });
    },
    async close() {
      await api.close();
      await temporalRelay.stop();
      await integrationRelay.stop();
      await worker?.shutdown();
      await native.close();
      await connection.close();
      await Promise.all([ig.close(), crm.close(), alerts.close()]);
      await dbh.drop();
    },
  };
  return h;
}

export type Harness = Awaited<ReturnType<typeof createHarness>>;
