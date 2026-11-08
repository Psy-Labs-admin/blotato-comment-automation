import { readPipelineHealth, type OperationsConfig } from './operations';
import type { Pool } from 'pg';
import { Counter, Gauge, Registry } from 'prom-client';

/**
 * Operational gauges are computed from Postgres at scrape time, so they are true for the whole
 * system regardless of which process serves /metrics. Labels are low-cardinality only (kind,
 * status, class) — run / user ids belong in logs and the timeline, not in metric labels.
 */
export function createMetrics(db: Pool, config: OperationsConfig = { dispatchConfigured: false }) {
  const registry = new Registry();

  // All gauges in a scrape share the same database observation.
  let collecting: ReturnType<typeof readPipelineHealth> | undefined;
  function sampleHealth() {
    collecting ??= readPipelineHealth(db, config).finally(() => {
      collecting = undefined;
    });
    return collecting;
  }
  const nativeWebhookDeliveries = new Counter({
    name: 'instagram_webhook_deliveries_total',
    help: 'Native Instagram delivery results',
    labelNames: ['result'],
    registers: [registry],
  });
  const nativeWebhookEvents = new Counter({
    name: 'instagram_webhook_events_total',
    help: 'Native normalized event ingest outcomes',
    labelNames: ['type', 'result'],
    registers: [registry],
  });
  new Gauge({
    name: 'pipeline_configured',
    help: 'Whether the API expects social dispatch',
    registers: [registry],
    collect() {
      this.set(config.dispatchConfigured ? 1 : 0);
    },
  });
  new Gauge({
    name: 'service_role_required',
    help: 'Whether this service role is required by the installation',
    labelNames: ['role'],
    registers: [registry],
    async collect() {
      const health = await sampleHealth();
      for (const role of health.roles) this.set({ role: role.role }, role.state === 'disabled' ? 0 : 1);
    },
  });
  new Gauge({
    name: 'delivery_destination_configured',
    help: 'Whether this destination is expected by API configuration or observed on a live relay',
    labelNames: ['kind'],
    registers: [registry],
    async collect() {
      const health = await sampleHealth();
      for (const consumer of health.consumers) this.set({ kind: consumer.kind }, consumer.configured ? 1 : 0);
    },
  });
  new Gauge({
    name: 'delivery_consumer_observed',
    help: 'Fresh healthy relay advertises this configured consumer',
    labelNames: ['kind'],
    registers: [registry],
    async collect() {
      const health = await sampleHealth();
      for (const consumer of health.consumers) this.set({ kind: consumer.kind }, consumer.observed ? 1 : 0);
    },
  });
  new Gauge({
    name: 'service_role_ready',
    help: 'Fresh successful worker or relay health observations',
    labelNames: ['role'],
    registers: [registry],
    async collect() {
      const health = await sampleHealth();
      for (const role of health.roles) this.set({ role: role.role }, role.state === 'ready' ? 1 : 0);
    },
  });
  new Gauge({
    name: 'service_role_last_observed_seconds',
    help: 'Unix timestamp of latest role probe, zero if missing',
    labelNames: ['role'],
    registers: [registry],
    async collect() {
      const health = await sampleHealth();
      for (const role of health.roles)
        this.set({ role: role.role }, role.lastSeenAt ? new Date(role.lastSeenAt).getTime() / 1000 : 0);
    },
  });
  const webhooks = new Counter({
    name: 'webhooks_received_total',
    help: 'Webhook deliveries by event type and ingest result',
    labelNames: ['type', 'result'],
    registers: [registry],
  });

  new Gauge({
    name: 'outbox_oldest_pending_seconds',
    help: 'Age of the oldest undelivered outbox row (start/signal lag, CRM lag, alert lag)',
    labelNames: ['kind'],
    registers: [registry],
    async collect() {
      this.reset();
      const r = await db.query(
        `SELECT kind, extract(epoch FROM now() - min(created_at))::float AS age FROM outbox WHERE status = 'pending' GROUP BY kind`,
      );
      for (const row of r.rows) this.set({ kind: row.kind }, row.age);
    },
  });
  new Gauge({
    name: 'outbox_dead_rows',
    help: 'Outbox rows that exhausted retries (kept for inspection)',
    labelNames: ['kind'],
    registers: [registry],
    async collect() {
      this.reset();
      const r = await db.query(`SELECT kind, count(*)::int AS n FROM outbox WHERE status = 'dead' GROUP BY kind`);
      for (const row of r.rows) this.set({ kind: row.kind }, row.n);
    },
  });
  new Gauge({
    name: 'inbox_unrouted_oldest_seconds',
    help: 'Age of the oldest accepted but not yet routed inbound event',
    registers: [registry],
    async collect() {
      const r = await db.query(
        `SELECT coalesce(extract(epoch FROM now() - min(received_at)), 0)::float AS age FROM inbox_events WHERE routing_status = 'pending'`,
      );
      this.set(r.rows[0].age);
    },
  });
  new Gauge({
    name: 'intents_unknown',
    help: 'Sends whose outcome is unknown (conversation held until resolved)',
    registers: [registry],
    async collect() {
      const r = await db.query(`SELECT count(*)::int AS n FROM message_intents WHERE status = 'unknown'`);
      this.set(r.rows[0].n);
    },
  });
  new Gauge({
    name: 'intents_unknown_oldest_seconds',
    help: 'Age of the oldest unresolved send',
    registers: [registry],
    async collect() {
      const r = await db.query(
        `SELECT coalesce(extract(epoch FROM now() - min(updated_at)), 0)::float AS age FROM message_intents WHERE status = 'unknown'`,
      );
      this.set(r.rows[0].age);
    },
  });
  new Gauge({
    name: 'runs_by_status',
    help: 'Automation runs by projected status',
    labelNames: ['status'],
    registers: [registry],
    async collect() {
      this.reset();
      const r = await db.query(`SELECT status, count(*)::int AS n FROM automation_runs GROUP BY status`);
      for (const row of r.rows) this.set({ status: row.status }, row.n);
    },
  });
  new Gauge({
    name: 'incidents_open',
    help: 'Open grouped incidents by class',
    labelNames: ['class'],
    registers: [registry],
    async collect() {
      this.reset();
      const r = await db.query(
        `SELECT error_class, count(*)::int AS n FROM incidents WHERE status = 'open' GROUP BY error_class`,
      );
      for (const row of r.rows) this.set({ class: row.error_class }, row.n);
    },
  });

  return { registry, webhooks, nativeWebhookDeliveries, nativeWebhookEvents };
}

export type Metrics = ReturnType<typeof createMetrics>;
