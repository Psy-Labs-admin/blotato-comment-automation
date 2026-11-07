import { Client, Connection } from '@temporalio/client';
import { NativeConnection } from '@temporalio/worker';
import { HttpAlertSink, TelegramNotifier, type AlertNotifier } from './adapters/alerts';
import { HttpCrmClient } from './adapters/crm';
import { HttpInstagramAdapter } from './adapters/instagram';
import { buildServer } from './api/server';
import { loadConfig } from './config';
import { systemClock } from './domain/clock';
import { startFakeAlertSink } from './fakes/fake-alert-sink';
import { startFakeCrm } from './fakes/fake-crm';
import { startFakeInstagram } from './fakes/fake-instagram';
import { routePending } from './ingest/router';
import { createMetrics } from './observability/metrics';
import { integrationHandlers, onDeadLetter } from './relay/integrations';
import { reconcileOrphans } from './relay/orphans';
import { OutboxRelay } from './relay/relay';
import { createPool } from './storage/db';
import { migrate } from './storage/migrate';
import { temporalHandlers } from './temporal/handlers';
import { startWorker, type RunningWorker } from './temporal/worker';

/**
 * One codebase, three roles. ROLE=all runs everything in one process (demo); in production API,
 * worker and relay run as separate deployments and scale independently.
 */
async function main() {
  const cfg = loadConfig();
  const db = createPool(cfg.databaseUrl);
  await migrate(db);
  const stops: Array<() => Promise<void>> = [];

  if (cfg.fakes) {
    const [ig, crm, sink] = await Promise.all([startFakeInstagram(4001), startFakeCrm(4002), startFakeAlertSink(4003, true)]);
    stops.push(ig.close, crm.close, sink.close);
    console.log('fakes: instagram :4001, crm :4002, alert sink :4003');
  }

  let temporalAddress = cfg.temporalAddress;
  if (temporalAddress === 'embedded') {
    // Dev convenience without Docker: the official Temporal dev server (downloads the CLI once).
    const { TestWorkflowEnvironment } = await import('@temporalio/testing');
    const env = await TestWorkflowEnvironment.createLocal({ server: { ip: '127.0.0.1', port: 7233, ui: true, uiPort: 8233 } });
    temporalAddress = env.address;
    stops.push(() => env.teardown());
    console.log(`embedded Temporal dev server at ${temporalAddress} (UI http://localhost:8233)`);
  }

  const relays: OutboxRelay[] = [];
  const poke = () => relays.forEach((r) => r.poke());
  const role = cfg.role;

  if (role === 'all' || role === 'worker') {
    const native = await NativeConnection.connect({ address: temporalAddress });
    const worker: RunningWorker = await startWorker({
      deps: { db, clock: systemClock, platform: new HttpInstagramAdapter(cfg.instagramBaseUrl, { timeoutMs: 10_000 }), onOutbox: poke },
      connection: native,
      namespace: cfg.temporalNamespace,
      taskQueue: cfg.taskQueue,
    });
    stops.push(async () => {
      await worker.shutdown();
      await native.close();
    });
    console.log(`worker polling task queue "${cfg.taskQueue}"`);
  }

  if (role === 'all' || role === 'relay') {
    const connection = await Connection.connect({ address: temporalAddress });
    const client = new Client({ connection, namespace: cfg.temporalNamespace });
    const notifier: AlertNotifier =
      cfg.telegramBotToken && cfg.telegramChatId ? new TelegramNotifier(cfg.telegramBotToken, cfg.telegramChatId) : new HttpAlertSink(cfg.alertSinkUrl);
    const onError = (err: unknown) => console.error('relay error', err);
    // Separate relays so a slow CRM never delays workflow starts/signals.
    relays.push(
      // Temporal commands are never dead-lettered: a Temporal outage only delays them
      // (visible as outbox_oldest_pending_seconds), it must not strand runs.
      new OutboxRelay({
        db, kinds: ['workflow.start', 'workflow.signal'], handlers: temporalHandlers({ client, db, taskQueue: cfg.taskQueue }),
        maxAttempts: Number.POSITIVE_INFINITY, onDead: onDeadLetter, onError,
      }),
      new OutboxRelay({
        db, kinds: ['crm.lead_captured', 'alert.notify'], onDead: onDeadLetter, onError,
        handlers: integrationHandlers({ db, crm: new HttpCrmClient(cfg.crmBaseUrl), notifier }),
      }),
    );
    relays.forEach((r) => r.start());
    // Sweeper: routes inbox events whose inline routing never ran (crash between ack and route).
    const sweeper = setInterval(
      () => routePending({ db, clock: systemClock, onOutbox: poke, onError: (err, id) => console.error('routing failed', id, err) }).catch(onError),
      2_000,
    );
    // Orphans: unfinished runs whose workflow is gone are finalized visibly.
    const orphans = setInterval(() => reconcileOrphans({ db, client, clock: systemClock }).catch(onError), 60_000);
    stops.push(async () => {
      clearInterval(sweeper);
      clearInterval(orphans);
      await Promise.all(relays.map((r) => r.stop()));
      await connection.close();
    });
    console.log(`relay running (alerts -> ${notifier instanceof TelegramNotifier ? 'Telegram' : cfg.alertSinkUrl})`);
  }

  if (role === 'all' || role === 'api') {
    const app = buildServer({ db, clock: systemClock, onOutbox: poke, metrics: createMetrics(db) });
    await app.listen({ port: cfg.port, host: '0.0.0.0' });
    stops.push(() => app.close());
  }

  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    console.log('shutting down...');
    for (const stop of stops.reverse()) await stop().catch((e) => console.error(e));
    await db.end();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
