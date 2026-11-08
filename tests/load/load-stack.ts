import { createConnection } from '../helpers/account';
import { createTestAccess } from '../helpers/test-access';
import { randomUUID } from 'node:crypto';
import { Client, Connection } from '@temporalio/client';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { NativeConnection } from '@temporalio/worker';
import { buildServer } from '../../src/api/server';
import { HttpAlertSink } from '../../src/adapters/alerts';
import { HttpCrmClient } from '../../src/adapters/crm';
import { HttpInstagramAdapter } from '../../src/adapters/instagram';
import { systemClock } from '../../src/domain/clock';
import { startFakeAlertSink } from '../fixtures/providers/fake-alert-sink';
import { startFakeCrm } from '../fixtures/providers/fake-crm';
import { startFakeInstagram } from '../fixtures/providers/fake-instagram';
import { HttpMetadataClient } from '../../src/metadata/client';
import { metadataHandler } from '../../src/metadata/hydrate';
import { integrationHandlers, onDeadLetter } from '../../src/relay/integrations';
import { OutboxRelay } from '../../src/relay/relay';
import { createAutomation, createTenant } from '../../src/storage/admin';
import { temporalHandlers } from '../../src/temporal/handlers';
import { startWorker } from '../../src/temporal/worker';
import { createTestDb } from '../helpers/db';
import { pricingWith } from '../helpers/definitions';

/** Uses production entry points with its own database, HTTP ports, Temporal server and queue. */
export async function createLoadStack(deliveries: number) {
  const admin = new URL(process.env.DATABASE_ADMIN_URL ?? 'postgres://postgres:postgres@localhost:55432/postgres');
  if (!['localhost', '127.0.0.1', '[::1]'].includes(admin.hostname)) throw new Error('Load checks require a loopback PostgreSQL admin endpoint');
  const cleanup: Array<() => Promise<void>> = [];
  const close = async () => {
    const errors: unknown[] = [];
    for (const stop of cleanup.reverse()) {
      try { await stop(); } catch (err) { errors.push(err); }
    }
    if (errors.length) throw new AggregateError(errors, 'Load check cleanup failed');
  };
  try {
    const database = await createTestDb();
    cleanup.push(database.drop);
    const db = database.db;
    const temporal = await TestWorkflowEnvironment.createLocal({ server: { ip: '127.0.0.1' } });
    cleanup.push(() => temporal.teardown());
    const ig = await startFakeInstagram();
    cleanup.push(ig.close);
    const crm = await startFakeCrm();
    cleanup.push(crm.close);
    const alerts = await startFakeAlertSink();
    cleanup.push(alerts.close);
    const connection = await Connection.connect({ address: temporal.address });
    cleanup.push(() => connection.close());
    const client = new Client({ connection });
    const native = await NativeConnection.connect({ address: temporal.address });
    cleanup.push(() => native.close());
    const taskQueue = `load-${randomUUID()}`;
    const relays: OutboxRelay[] = [];
    const poke = () => relays.forEach((relay) => relay.poke());
    const worker = await startWorker({
      deps: { db, integrationMode: 'gateway', clock: systemClock, platform: new HttpInstagramAdapter(ig.url), onOutbox: poke },
      connection: native, taskQueue,
    });
    cleanup.push(() => worker.shutdown());
    relays.push(
      new OutboxRelay({ db, kinds: ['workflow.start', 'workflow.signal'], handlers: temporalHandlers({ db, client, taskQueue }), maxAttempts: Infinity, onDead: onDeadLetter }),
      new OutboxRelay({ db, kinds: ['crm.lead_captured', 'alert.notify'], handlers: integrationHandlers({ db, crm: new HttpCrmClient(crm.url), notifier: new HttpAlertSink(alerts.url) }), onDead: onDeadLetter }),
      new OutboxRelay({ db, kinds: ['metadata.hydrate'], handlers: { 'metadata.hydrate': metadataHandler({ db, client: new HttpMetadataClient(ig.url) }) }, onDead: onDeadLetter }),
    );
    relays.forEach((relay) => relay.start());
    cleanup.push(async () => { await Promise.all(relays.map((relay) => relay.stop())); });
    const tenantId = await createTenant(db, 'isolated-load-check');
    const accountId = `load_${randomUUID()}`;
    const connectionId = await createConnection(db, { tenantId, accountId, capabilities: { sendsPerWindow: deliveries * 10, recipientHourlyLimit: 10 } });
    await db.query(
      "UPDATE social_connections SET integration_kind = 'gateway', verified_at = now(), integration_revision = 1, integration_updated_at = now() WHERE id = $1",
      [connectionId],
    );
    await createAutomation(db, { dispatchConfigured: true, integrationMode: 'gateway', tenantId, connectionId, name: 'load pricing', definition: pricingWith({ timeout: '10m' }), cooldownSeconds: 0 });
    const auth = createTestAccess();
    const app = buildServer({ db, access: auth.access, dispatchConfigured: true, integrationMode: 'gateway', clock: systemClock, logger: false, onOutbox: poke });
    const url = await app.listen({ host: '127.0.0.1', port: 0 });
    cleanup.push(() => app.close());
    return { db, ig, crm, accountId, url, close, auth };
  } catch (err) {
    await close();
    throw err;
  }
}
