import type { Pool } from 'pg';
import { HEARTBEAT_STALE_SECONDS } from './heartbeat';

export const DELIVERY_KINDS = [
  'workflow.start',
  'workflow.signal',
  'crm.lead_captured',
  'alert.notify',
  'metadata.hydrate',
] as const;
export type DeliveryKind = (typeof DELIVERY_KINDS)[number];
export const DELIVERY_LABELS: Record<DeliveryKind, string> = {
  'workflow.start': 'Start conversation',
  'workflow.signal': 'Continue conversation',
  'crm.lead_captured': 'Send lead to CRM',
  'alert.notify': 'Send operational notification',
  'metadata.hydrate': 'Read post details',
};
export interface OperationsConfig {
  dispatchConfigured: boolean;
  namespace?: string;
  taskQueue?: string;
  destinations?: {
    crm: boolean;
    alerts: boolean;
    metadata: boolean;
    alertChannel?: 'telegram' | 'webhook' | null;
    alertDestinationKey?: string | null;
  };
}

export function destinationConfigured(kind: DeliveryKind, config: OperationsConfig): boolean {
  if (kind === 'crm.lead_captured') return config.destinations?.crm ?? false;
  if (kind === 'alert.notify') return config.destinations?.alerts ?? false;
  if (kind === 'metadata.hydrate') return config.destinations?.metadata ?? false;
  return config.dispatchConfigured;
}

export interface DeliveryConsumer {
  kind: DeliveryKind;
  expected: boolean;
  configured: boolean;
  observed: boolean;
  state: 'ready' | 'unavailable' | 'disabled';
}

/** Read at most one historical observation per role, plus only the recent indexed range. */
export async function readPipelineHealth(db: Pick<Pool, 'query'>, config: OperationsConfig) {
  const observed = await db.query(
    `SELECT roles.role,latest.observed_at,
       coalesce(recent.ready_count,0)::int AS ready_count,coalesce(recent.fresh_count,0)::int AS fresh_count,
       coalesce(recent.capabilities,'{}'::text[]) AS capabilities
     FROM (VALUES ('worker'),('relay')) roles(role)
     LEFT JOIN LATERAL (
       SELECT observed_at FROM service_heartbeats
       WHERE temporal_namespace=$1 AND task_queue=$2 AND role=roles.role ORDER BY observed_at DESC LIMIT 1
     ) latest ON true
     LEFT JOIN LATERAL (
       SELECT count(DISTINCT h.instance_id) FILTER(WHERE h.state='ready') AS ready_count,
         count(DISTINCT h.instance_id) AS fresh_count,
         array_agg(DISTINCT cap) FILTER(WHERE h.state='ready' AND cap IS NOT NULL) AS capabilities
       FROM service_heartbeats h LEFT JOIN LATERAL unnest(h.capabilities) cap ON true
       WHERE h.temporal_namespace=$1 AND h.task_queue=$2 AND h.role=roles.role
         AND h.observed_at>now()-make_interval(secs=>$3)
     ) recent ON true`,
    [config.namespace ?? 'default', config.taskQueue ?? 'comment-automations', HEARTBEAT_STALE_SECONDS],
  );
  const relay = observed.rows.find((row) => row.role === 'relay');
  const capabilities: string[] = relay?.capabilities ?? [];
  const flags: Record<DeliveryKind, string> = {
    'workflow.start': 'dispatch',
    'workflow.signal': 'dispatch',
    'crm.lead_captured': 'crm',
    'alert.notify': 'alerts',
    'metadata.hydrate': 'metadata',
  };
  const expectedChannel = config.destinations?.alertChannel ?? null;
  const expectedKey = config.destinations?.alertDestinationKey ?? null;
  const identities = capabilities.flatMap((cap) => {
    const match = /^alert\.(telegram|webhook):([a-f0-9]{64})$/.exec(cap);
    return match ? [{ channel: match[1] as 'telegram' | 'webhook', key: match[2] }] : [];
  });
  const expectedIdentity = expectedChannel && expectedKey ? { channel: expectedChannel, key: expectedKey } : null;
  const currentIdentity = expectedIdentity ?? (identities.length === 1 ? identities[0] : null);
  const consumers: DeliveryConsumer[] = DELIVERY_KINDS.map((kind) => {
    let available = capabilities.includes(flags[kind]);
    if (kind === 'alert.notify' && expectedChannel)
      available =
        available &&
        identities.some((i) => i.channel === expectedChannel && (!expectedKey || i.key === expectedKey));
    const expected = destinationConfigured(kind, config);
    const configured = expected || available;
    return {
      kind,
      expected,
      configured,
      observed: available,
      state: available ? 'ready' : configured ? 'unavailable' : 'disabled',
    };
  });
  const missingConsumers = consumers.filter((c) => c.configured && !c.observed).map((c) => c.kind);
  const relayRequired = config.dispatchConfigured || consumers.some((c) => c.configured);
  const roles = (['worker', 'relay'] as const).map((role) => {
    const row = observed.rows.find((r) => r.role === role);
    const required = role === 'worker' ? config.dispatchConfigured : relayRequired;
    const state = !required
      ? 'disabled'
      : row?.ready_count
        ? role === 'relay' && missingConsumers.length
          ? 'degraded'
          : 'ready'
        : row?.fresh_count
          ? 'degraded'
          : row?.observed_at
            ? 'stale'
            : 'missing';
    return { role, state, lastSeenAt: row?.observed_at ?? null, instances: row?.ready_count ?? 0 };
  });
  return {
    state: !relayRequired
      ? 'disabled'
      : roles.every((role) => role.state === 'ready' || role.state === 'disabled')
        ? 'ready'
        : 'attention',
    roles,
    consumers,
    missingConsumers,
    notificationDestination: currentIdentity,
  };
}

export async function readOperations(db: Pool, tenantId: string, config: OperationsConfig) {
  const health = await readPipelineHealth(db, config);
  const { notificationDestination: destination, ...publicHealth } = health;
  const [queues, counts, notifications] = await Promise.all([
    db.query(
      `SELECT kind,count(*) FILTER(WHERE status='pending')::int AS pending,
       count(*) FILTER(WHERE status='dead')::int AS dead,
       count(*) FILTER(WHERE status='pending' AND locked_until>now())::int AS in_flight,
       min(created_at) FILTER(WHERE status='pending') AS oldest_pending_at,
       min(next_attempt_at) FILTER(WHERE status='pending') AS next_attempt_at
       FROM outbox WHERE tenant_id=$1 GROUP BY kind`,
      [tenantId],
    ),
    db.query(
      `SELECT
       (SELECT count(*)::int FROM message_intents WHERE tenant_id=$1 AND status='unknown') AS unknown_sends,
       (SELECT count(*)::int FROM inbox_events WHERE tenant_id=$1 AND routing_status='pending') AS unrouted,
       (SELECT min(received_at) FROM inbox_events WHERE tenant_id=$1 AND routing_status='pending') AS oldest_unrouted,
       (SELECT count(*)::int FROM incidents WHERE tenant_id=$1 AND status='open') AS open,
       (SELECT count(*)::int FROM incidents WHERE tenant_id=$1 AND status='resolved') AS resolved`,
      [tenantId],
    ),
    db.query(
      `SELECT status,last_attempt_at,(SELECT max(accepted_at) FROM alert_deliveries WHERE tenant_id=$1 AND channel=$2 AND channel_key=$3) AS accepted_at,last_error_code FROM alert_deliveries
       WHERE tenant_id=$1 AND channel=$2 AND channel_key=$3 ORDER BY last_attempt_at DESC NULLS LAST,outbox_id DESC LIMIT 1`,
      [tenantId, destination?.channel ?? null, destination?.key ?? null],
    ),
  ]);
  const count = counts.rows[0];
  const byKind = new Map(queues.rows.map((row) => [row.kind, row]));
  const alertQueue = byKind.get('alert.notify');
  const lastNotice = notifications.rows[0];
  return {
    asOf: new Date().toISOString(),
    pipeline: {
      ...publicHealth,
      dispatchConfigured: config.dispatchConfigured,
      unknownSends: count.unknown_sends,
      unroutedEvents: count.unrouted,
      oldestUnroutedAt: count.oldest_unrouted,
    },
    queues: DELIVERY_KINDS.map((kind) => {
      const queue = byKind.get(kind);
      const consumer = health.consumers.find((c) => c.kind === kind)!;
      return {
        ...consumer,
        label: DELIVERY_LABELS[kind],
        pending: queue?.pending ?? 0,
        dead: queue?.dead ?? 0,
        inFlight: queue?.in_flight ?? 0,
        oldestPendingAt: queue?.oldest_pending_at ?? null,
        nextAttemptAt: queue?.next_attempt_at ?? null,
      };
    }),
    incidents: { open: count.open, resolved: count.resolved },
    notifications: {
      expected: config.destinations?.alerts ?? false,
      configured: health.consumers.find((c) => c.kind === 'alert.notify')!.configured,
      observed: health.consumers.find((c) => c.kind === 'alert.notify')!.observed,
      channel: destination?.channel ?? config.destinations?.alertChannel ?? null,
      pending: alertQueue?.pending ?? 0,
      failed: alertQueue?.dead ?? 0,
      lastAttemptAt: lastNotice?.last_attempt_at ?? null,
      lastAcceptedAt: lastNotice?.accepted_at ?? null,
      lastOutcome: lastNotice?.status ?? null,
      lastErrorCode: lastNotice?.last_error_code ?? null,
    },
  };
}
