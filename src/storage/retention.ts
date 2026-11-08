import type { Pool } from 'pg';
import { withTx } from './db';

/** Explicit opt-in. Redacts only old routed inbox text after the entire conversation is quiescent. */
export async function redactExpiredInbox(db: Pool, options: {
  enabled: boolean; olderThanDays?: number; batchSize?: number;
}): Promise<number> {
  if (!options.enabled) return 0;
  const days = options.olderThanDays ?? 30;
  const limit = options.batchSize ?? 100;
  if (!Number.isSafeInteger(days) || days < 1 || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
    throw new Error('Retention requires positive integer days and a batch size between 1 and 1000');
  }
  return withTx(db, async (c) => {
    const conversations = await c.query(
      `SELECT c.id FROM conversations c WHERE c.owner_run_id IS NULL
         AND NOT EXISTS (SELECT 1 FROM automation_runs r WHERE r.conversation_id = c.id AND r.finished_at IS NULL)
         AND NOT EXISTS (SELECT 1 FROM input_waits w WHERE w.conversation_id = c.id AND w.status IN ('prepared', 'active'))
         AND NOT EXISTS (SELECT 1 FROM message_intents i WHERE i.conversation_id = c.id AND i.status IN ('in_flight', 'unknown'))
         AND EXISTS (SELECT 1 FROM inbox_events e WHERE e.conversation_id = c.id AND e.routing_status = 'routed'
           AND e.text_redacted_at IS NULL AND e.received_at < now() - make_interval(days => $1))
       ORDER BY c.id LIMIT $2 FOR UPDATE OF c SKIP LOCKED`, [days, limit],
    );
    if (!conversations.rowCount) return 0;
    const redacted = await c.query(
      `UPDATE inbox_events SET text = '[redacted]', text_redacted_at = now() WHERE id IN (
         SELECT id FROM inbox_events WHERE conversation_id = ANY($1::uuid[]) AND routing_status = 'routed'
           AND text_redacted_at IS NULL AND received_at < now() - make_interval(days => $2)
         ORDER BY received_at, id LIMIT $3 FOR UPDATE SKIP LOCKED
       )`, [conversations.rows.map((row) => row.id), days, limit],
    );
    return redacted.rowCount ?? 0;
  });
}
