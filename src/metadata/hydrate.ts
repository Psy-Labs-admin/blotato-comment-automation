import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { OutboxHandler } from '../relay/relay';
import type { MetadataClient } from './client';

/** Dedicated relay handler. Network calls happen after durable acceptance and outside DB transactions. */
export function metadataHandler(o: {
  db: Pool; client: MetadataClient; ttlSeconds?: number; negativeTtlSeconds?: number;
}): OutboxHandler {
  const ttl = o.ttlSeconds ?? 3600;
  const negativeTtl = o.negativeTtlSeconds ?? 300;
  if (![ttl, negativeTtl].every((value) => Number.isSafeInteger(value) && value > 0)) {
    throw new Error('Metadata cache TTLs must be positive integer seconds');
  }
  return async (row) => {
    const event = (await o.db.query(
      `SELECT e.tenant_id, e.connection_id, e.media_id, sc.external_account_id
         FROM inbox_events e JOIN social_connections sc ON sc.id = e.connection_id
        WHERE e.id = $1 AND e.tenant_id = $2 AND e.event_type = 'comment.created'`,
      [row.payload.eventId, row.tenantId],
    )).rows[0];
    if (!event?.media_id) return;
    await o.db.query(
      `INSERT INTO post_metadata_cache (tenant_id, connection_id, media_id) VALUES ($1, $2, $3)
       ON CONFLICT (connection_id, media_id) DO NOTHING`, [event.tenant_id, event.connection_id, event.media_id],
    );
    const token = randomUUID();
    const claim = await o.db.query(
      `UPDATE post_metadata_cache SET refresh_token = $3, refreshing_until = now() + interval '30 seconds'
        WHERE connection_id = $1 AND media_id = $2 AND expires_at <= now()
          AND (refreshing_until IS NULL OR refreshing_until <= now()) RETURNING connection_id`,
      [event.connection_id, event.media_id, token],
    );
    if (!claim.rowCount) {
      const current = (await o.db.query(
        `SELECT expires_at > now() AS fresh FROM post_metadata_cache WHERE connection_id = $1 AND media_id = $2`,
        [event.connection_id, event.media_id],
      )).rows[0];
      return current?.fresh ? undefined : { retryInMs: 500, reason: 'metadata refresh in progress' };
    }
    try {
      const result = await o.client.fetchPost(event.external_account_id, event.media_id);
      const saved = await o.db.query(
        `UPDATE post_metadata_cache SET status = $4, metadata = $5, fetched_at = now(),
           expires_at = now() + make_interval(secs => $6), refresh_token = NULL, refreshing_until = NULL
         WHERE connection_id = $1 AND media_id = $2 AND refresh_token = $3`,
        [event.connection_id, event.media_id, token, result.status,
          result.status === 'available' ? result.metadata : null, result.status === 'available' ? ttl : negativeTtl],
      );
      if (!saved.rowCount) return { retryInMs: 500, reason: 'metadata refresh lease changed' };
    } catch (err) {
      await o.db.query(
        `UPDATE post_metadata_cache SET refresh_token = NULL, refreshing_until = NULL
          WHERE connection_id = $1 AND media_id = $2 AND refresh_token = $3`,
        [event.connection_id, event.media_id, token],
      );
      throw err;
    }
  };
}
