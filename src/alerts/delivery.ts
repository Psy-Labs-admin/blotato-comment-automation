import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { AlertNotifier } from '../adapters/alerts';
import type { OutboxHandler, OutboxRow } from '../relay/relay';
import type { AlertNotifyPayload } from '../storage/outbox';
import { NotificationError } from './errors';
import { formatIncident } from './format';

function channelIdentity(notifier: AlertNotifier) {
  const key = notifier.channelKey ?? createHash('sha256').update('configured-operational-webhook').digest('hex');
  if (!/^[a-f0-9]{64}$/.test(key)) throw new NotificationError('alert_channel_invalid', { permanent: true });
  const unsigned = BigInt('0x' + key.slice(0, 16));
  const lock = unsigned > 0x7fffffffffffffffn ? unsigned - 0x10000000000000000n : unsigned;
  return { key, lock: lock.toString(), channel: notifier.channel ?? 'webhook' };
}

async function record(
  c: PoolClient,
  row: OutboxRow,
  scope: ReturnType<typeof channelIdentity>,
  incidentId: string,
  status: 'accepted' | 'retryable' | 'permanent' | 'unknown' | 'skipped',
  code?: string,
  providerId?: string,
  retryAfterMs?: number,
) {
  await c.query(
    `INSERT INTO alert_deliveries(outbox_id,tenant_id,incident_id,channel,channel_key,status,attempts,accepted_at,last_error_code,provider_message_id,retry_not_before)
     VALUES($1,$2,$3,$4,$5,$6,1,CASE WHEN $6='accepted' THEN now() END,$7,$8,CASE WHEN $9::float IS NOT NULL THEN now()+make_interval(secs=>$9/1000) END)
     ON CONFLICT(outbox_id) DO UPDATE SET
       channel=excluded.channel,channel_key=excluded.channel_key,
       status=excluded.status, attempts=alert_deliveries.attempts+1,last_attempt_at=now(),
       accepted_at=excluded.accepted_at,last_error_code=excluded.last_error_code,
       provider_message_id=excluded.provider_message_id,retry_not_before=excluded.retry_not_before
     WHERE alert_deliveries.status <> 'accepted'`,
    [
      row.id,
      row.tenantId,
      incidentId,
      scope.channel,
      scope.key,
      status,
      code ?? null,
      providerId ?? null,
      retryAfterMs ?? null,
    ],
  );
}

/** Serializes a configured operator destination without retaining a database transaction during HTTP. */
export function alertDeliveryHandler(o: {
  db: Pool;
  notifier?: AlertNotifier;
  consoleUrl?: string;
}): OutboxHandler {
  return async (row) => {
    if (!o.notifier) return { retryInMs: 60_000, reason: 'alert_delivery_unconfigured' };
    const payload = row.payload as AlertNotifyPayload;
    if (
      !row.tenantId ||
      !/^\d+$/.test(row.id) ||
      !['opened', 'update', 'resolved'].includes(payload?.kind) ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(payload?.incidentId ?? '')
    ) {
      throw new NotificationError('alert_scope_invalid', { permanent: true });
    }
    const scope = channelIdentity(o.notifier);
    const c = await o.db.connect();
    let acquired = false;
    try {
      acquired = (await c.query('SELECT pg_try_advisory_lock($1::bigint) AS acquired', [scope.lock])).rows[0]
        .acquired;
      if (!acquired) return { retryInMs: 500, reason: 'alert_channel_busy' };
      const stored = (
        await c.query(
          `SELECT o.status,o.claim_token,d.status AS delivery_status FROM outbox o LEFT JOIN alert_deliveries d ON d.outbox_id=o.id
          WHERE o.id=$1 AND o.tenant_id=$2 AND o.kind='alert.notify' AND o.payload->>'incidentId'=$3 AND o.payload->>'kind'=$4`,
          [row.id, row.tenantId, payload.incidentId, payload.kind],
        )
      ).rows[0];
      if (!stored) throw new NotificationError('alert_scope_invalid', { permanent: true });
      if (stored.status !== 'pending' || stored.delivery_status === 'accepted') return;
      if (row.claimToken && stored.claim_token !== row.claimToken)
        return { retryInMs: 500, reason: 'alert_claim_changed' };
      const prior = await c.query(
        `SELECT 1 FROM outbox o LEFT JOIN alert_deliveries d ON d.outbox_id=o.id
          WHERE o.kind='alert.notify' AND o.tenant_id=$1 AND o.payload->>'incidentId'=$2 AND o.id<$3
            AND o.status='pending' AND d.status IS DISTINCT FROM 'accepted' LIMIT 1`,
        [row.tenantId, payload.incidentId, row.id],
      );
      if (prior.rowCount) return { retryInMs: 500, reason: 'alert_waiting_for_previous_delivery' };
      const flood = (
        await c.query(
          `SELECT greatest(0,extract(epoch FROM max(retry_not_before)-now())*1000)::float AS ms
           FROM alert_deliveries WHERE channel_key=$1 AND retry_not_before>now()`,
          [scope.key],
        )
      ).rows[0].ms;
      if (flood > 0) return { retryInMs: Math.ceil(flood), reason: 'alert_channel_rate_limited' };
      const inc = (
        await c.query('SELECT * FROM incidents WHERE id=$1 AND tenant_id=$2', [payload.incidentId, row.tenantId])
      ).rows[0];
      if (!inc) throw new NotificationError('alert_scope_invalid', { permanent: true });
      const accepted = !!(
        await c.query(
          `SELECT 1 FROM alert_deliveries WHERE incident_id=$1 AND tenant_id=$2 AND channel_key=$3 AND channel=$4 AND status='accepted' LIMIT 1`,
          [payload.incidentId, row.tenantId, scope.key, scope.channel],
        )
      ).rowCount;
      if (
        (inc.status === 'resolved' && payload.kind !== 'resolved') ||
        (payload.kind === 'resolved' && !accepted)
      ) {
        await record(c, row, scope, inc.id, 'skipped', 'alert_obsolete');
        return;
      }
      try {
        const receipt = await o.notifier.notify(
          formatIncident(inc, payload.kind === 'update' && !accepted ? 'opened' : payload.kind, o.consoleUrl),
        );
        await record(c, row, scope, inc.id, 'accepted', undefined, receipt?.providerMessageId);
      } catch (error) {
        const failure =
          error instanceof NotificationError
            ? error
            : new NotificationError('alert_delivery_unknown', { uncertain: true });
        const status = failure.options.permanent
          ? 'permanent'
          : failure.options.uncertain
            ? 'unknown'
            : 'retryable';
        await record(c, row, scope, inc.id, status, failure.code, undefined, failure.options.retryAfterMs);
        throw failure;
      }
    } finally {
      let discard = false;
      if (acquired) {
        try {
          await c.query('SELECT pg_advisory_unlock($1::bigint)', [scope.lock]);
        } catch {
          discard = true;
        }
      }
      c.release(discard);
    }
  };
}
