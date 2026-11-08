import { InstagramGraphPlatform } from './instagram/platform';
import { getInstagramCredentials, refreshDueInstagramAccounts } from './instagram/accounts';
import type { SocialPlatform } from './adapters/instagram';
import type { MetadataClient } from './metadata/client';
import { Client, Connection } from '@temporalio/client';
import { NativeConnection } from '@temporalio/worker';
import { HttpAlertSink, TelegramNotifier, type AlertNotifier } from './adapters/alerts';
import { HttpCrmClient } from './adapters/crm';
import { HttpInstagramAdapter } from './adapters/instagram';
import { loadAccess } from './api/access';
import { buildServer } from './api/server';
import { loadConfig } from './config';
import { systemClock } from './domain/clock';
import { metadataHandler } from './metadata/hydrate';
import { HttpMetadataClient } from './metadata/client';
import { redactExpiredInbox } from './storage/retention';
import { routePending } from './ingest/router';
import { createTracing } from './observability/tracing';
import { createMetrics } from './observability/metrics';
import { integrationHandlers, onDeadLetter } from './relay/integrations';
import { reconcileOrphans } from './relay/orphans';
import { OutboxRelay } from './relay/relay';
import { createPool } from './storage/db';
import { migrate } from './storage/migrate';
import { temporalHandlers } from './temporal/handlers';
import { startWorker, workerDeploymentOptionsFromEnv, type RunningWorker } from './temporal/worker';

/**
 * One codebase, three roles. ROLE=all runs all configured processes together. API,
 * worker and relay run as separate deployments and scale independently.
 */
async function main() {
  const cfg = loadConfig();
  const servesHttp = cfg.role === 'api' || cfg.role === 'all';
  const access = servesHttp ? loadAccess(process.env) : undefined;
  const db = createPool(cfg.databaseUrl);
  await migrate(db);
  const tracing = createTracing(process.env);
  const stops: Array<() => Promise<void>> = [() => tracing.shutdown()];

  const relays: OutboxRelay[] = [];
  const poke = () => relays.forEach((r) => r.poke());
  const role = cfg.role;
  const nativePlatform = cfg.nativeInstagram ? new InstagramGraphPlatform({
    graphVersion: cfg.nativeInstagram.graphVersion,
    credentials: (accountId) => getInstagramCredentials({ db, encryptionKey: cfg.nativeInstagram!.encryptionKey, clock: systemClock }, accountId),
  }) : undefined;
  const platform: SocialPlatform | undefined = nativePlatform ?? (cfg.instagram
    ? new HttpInstagramAdapter(cfg.instagram.baseUrl, { timeoutMs: 10_000, token: cfg.instagram.token }) : undefined);
  const metadata: MetadataClient | undefined = nativePlatform ?? (cfg.instagram
    ? new HttpMetadataClient(cfg.instagram.baseUrl, 5_000, cfg.instagram.token) : undefined);

  if (role === 'all' || role === 'worker') {
    const native = await NativeConnection.connect({ address: cfg.temporalAddress });
    const worker: RunningWorker = await startWorker({
      deps: { db, integrationMode: cfg.nativeInstagram ? 'native' : cfg.instagram ? 'gateway' : 'unconfigured', tracing, clock: systemClock, platform: platform!, onOutbox: poke },
      deploymentOptions: workerDeploymentOptionsFromEnv(),
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
    const connection = await Connection.connect({ address: cfg.temporalAddress });
    const client = new Client({ connection, namespace: cfg.temporalNamespace });
    const notifier: AlertNotifier | undefined = cfg.telegramBotToken && cfg.telegramChatId
      ? new TelegramNotifier(cfg.telegramBotToken, cfg.telegramChatId)
      : cfg.alertSink ? new HttpAlertSink(cfg.alertSink.baseUrl, { token: cfg.alertSink.token }) : undefined;
    const crm = cfg.crm ? new HttpCrmClient(cfg.crm.baseUrl, { token: cfg.crm.token }) : undefined;
    const onError = (err: unknown) => console.error('relay error', err);
    const integrations = integrationHandlers({ db, crm, notifier, consoleUrl: cfg.consoleUrl });
    // Each configured service advances independently. Unconfigured destinations retain pending outbox rows.
    relays.push(new OutboxRelay({
      db, tracing, kinds: ['workflow.start', 'workflow.signal'],
      handlers: temporalHandlers({ client, db, taskQueue: cfg.taskQueue }),
      maxAttempts: Number.POSITIVE_INFINITY, onDead: onDeadLetter, onError,
    }));
    if (crm) relays.push(new OutboxRelay({
      db, tracing, kinds: ['crm.lead_captured'], handlers: integrations, onDead: onDeadLetter, onError,
    }));
    if (notifier) relays.push(new OutboxRelay({
      db, tracing, kinds: ['alert.notify'], handlers: integrations, onDead: onDeadLetter, onError,
    }));
    if (metadata) relays.push(new OutboxRelay({
      db, tracing, kinds: ['metadata.hydrate'], onDead: onDeadLetter, onError,
      handlers: { 'metadata.hydrate': metadataHandler({ db, client: metadata }) },
    }));
    if (cfg.nativeInstagram) {
      let refreshing: Promise<void> | undefined;
      const refresh = setInterval(() => {
        if (refreshing) return;
        refreshing = refreshDueInstagramAccounts({ db, config: cfg.nativeInstagram!, clock: systemClock })
          .then(() => undefined).catch(onError).finally(() => { refreshing = undefined; });
      }, 60_000);
      stops.push(async () => { clearInterval(refresh); await refreshing; });
    }
    if (cfg.inboxRetentionEnabled) {
      const timer = setInterval(() => redactExpiredInbox(db, {
        enabled: true, olderThanDays: cfg.inboxRetentionDays,
      }).catch(onError), 60_000);
      stops.push(async () => clearInterval(timer));
    }
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
    console.log('configured relays are running');
  }

  if (role === 'all' || role === 'api') {
    const app = buildServer({ db, access: access!,
      dispatchConfigured: cfg.dispatchEnabled,
      integrationMode: cfg.nativeInstagram ? 'native' : cfg.instagram ? 'gateway' : 'unconfigured',
      nativeInstagram: cfg.nativeInstagram,
      provisioningSecret: cfg.provisioningSecret,
      integrationSettingsUrl: cfg.integrationSettingsUrl,
      consoleOrigin: cfg.consoleUrl ? new URL(cfg.consoleUrl).origin : undefined,
      tracing, clock: systemClock, onOutbox: poke, metrics: createMetrics(db) });
    await app.listen({ port: cfg.port, host: cfg.host });
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
