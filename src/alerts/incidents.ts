import type { PoolClient } from 'pg';
import { enqueueOutbox } from '../storage/outbox';

export type IncidentClass =
  | 'send_outcome_unknown'
  | 'connection_unauthorized'
  | 'crm_delivery_failing'
  | 'outbox_dead_letter';

/** Re-notify an open incident at most this often; between notifications occurrences are only counted. */
export const NOTIFY_THROTTLE_SECONDS = 15 * 60;

const NULL_UUID = '00000000-0000-0000-0000-000000000000';

/**
 * Groups failures into one open incident per (tenant, connection, class). The first occurrence and
 * then at most one update per throttle window produce a notification; everything else only counts.
 */
export async function raiseIncident(
  c: PoolClient,
  i: { tenantId: string; connectionId?: string | null; errorClass: IncidentClass; runId?: string | null },
): Promise<void> {
  const row = (
    await c.query(
      `INSERT INTO incidents (tenant_id, connection_id, error_class, affected_runs)
       VALUES ($1, $2, $3, CASE WHEN $4::uuid IS NULL THEN '{}'::uuid[] ELSE ARRAY[$4::uuid] END)
       ON CONFLICT (tenant_id, coalesce(connection_id, '${NULL_UUID}'::uuid), error_class) WHERE status = 'open'
       DO UPDATE SET occurrences = incidents.occurrences + 1, last_seen_at = now(),
         affected_runs = CASE WHEN $4::uuid IS NULL OR $4::uuid = ANY(incidents.affected_runs)
                              THEN incidents.affected_runs ELSE incidents.affected_runs || $4::uuid END
       RETURNING id, notify_count, (last_notified_at IS NULL OR last_notified_at < now() - make_interval(secs => $5)) AS due`,
      [i.tenantId, i.connectionId ?? null, i.errorClass, i.runId ?? null, NOTIFY_THROTTLE_SECONDS],
    )
  ).rows[0];
  if (!row.due) return;
  const n = row.notify_count + 1;
  await c.query(`UPDATE incidents SET notify_count = $2, last_notified_at = now() WHERE id = $1`, [row.id, n]);
  await enqueueOutbox(c, {
    tenantId: i.tenantId,
    kind: 'alert.notify',
    idempotencyKey: `alert:${row.id}:${n}`,
    payload: { incidentId: row.id, kind: n === 1 ? 'opened' : 'update' },
  });
}

/** Closes the "unknown send" incident of an account once none of its sends is unknown any more. */
export async function settleUnknownIncident(c: PoolClient, i: { tenantId: string; connectionId: string }): Promise<void> {
  const left = (
    await c.query(`SELECT count(*)::int AS n FROM message_intents WHERE connection_id = $1 AND status = 'unknown'`, [i.connectionId])
  ).rows[0].n;
  if (left === 0) await resolveIncident(c, { ...i, errorClass: 'send_outcome_unknown' });
}

export async function resolveIncident(
  c: PoolClient,
  i: { tenantId: string; connectionId?: string | null; errorClass: IncidentClass },
): Promise<void> {
  const r = await c.query(
    `UPDATE incidents SET status = 'resolved', resolved_at = now()
      WHERE tenant_id = $1 AND coalesce(connection_id, '${NULL_UUID}'::uuid) = coalesce($2::uuid, '${NULL_UUID}'::uuid)
        AND error_class = $3 AND status = 'open'
      RETURNING id, notify_count`,
    [i.tenantId, i.connectionId ?? null, i.errorClass],
  );
  for (const row of r.rows) {
    if (row.notify_count > 0) {
      await enqueueOutbox(c, {
        tenantId: i.tenantId,
        kind: 'alert.notify',
        idempotencyKey: `alert:${row.id}:resolved`,
        payload: { incidentId: row.id, kind: 'resolved' },
      });
    }
  }
}
