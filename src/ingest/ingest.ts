import type { Pool } from 'pg';
import type { Clock } from '../domain/clock';
import { isStopCommand } from '../domain/matching';
import { Reason } from '../domain/reasons';
import { audit } from '../storage/audit';
import { requestRunCancel } from '../storage/controls';
import { withTx } from '../storage/db';
import { enqueueOutbox } from '../storage/outbox';
import { NormalizedEventSchema } from './events';

export type IngestResult =
  | { status: 'accepted'; eventId: string; duplicate: boolean }
  | { status: 'rejected'; httpStatus: 400 | 404; reason: string };

export interface IngestDeps {
  db: Pool;
  clock: Clock;
}

/**
 * Step 1 of the pipeline: make the event durable, deduplicated and ordered, then acknowledge.
 * Routing is a separate step (inline fast path + sweeper), so a slow or failing router never
 * makes us drop or double-accept a webhook.
 *
 * Everything happens under the conversation row lock, which gives each event a per-conversation
 * sequence number consistent with the prompt boundary recorded by the send ledger.
 */
export async function ingestEvent(deps: IngestDeps, raw: unknown): Promise<IngestResult> {
  const parsed = NormalizedEventSchema.safeParse(raw);
  if (!parsed.success) {
    return { status: 'rejected', httpStatus: 400, reason: `invalid_event: ${parsed.error.issues.map((i) => i.path.join('.')).join(',')}` };
  }
  const e = parsed.data;

  return withTx(deps.db, async (c) => {
    const conn = await c.query(
      `SELECT id, tenant_id, external_account_id FROM social_connections WHERE platform = 'instagram' AND external_account_id = $1`,
      [e.accountId],
    );
    if (!conn.rowCount) return { status: 'rejected', httpStatus: 404, reason: 'unknown_account' } as const;
    const { id: connectionId, tenant_id: tenantId, external_account_id: ownAccount } = conn.rows[0];

    await c.query(
      `INSERT INTO conversations (tenant_id, connection_id, participant_id) VALUES ($1, $2, $3)
       ON CONFLICT (connection_id, participant_id) DO NOTHING`,
      [tenantId, connectionId, e.from.id],
    );
    const conv = (
      await c.query(`SELECT * FROM conversations WHERE connection_id = $1 AND participant_id = $2 FOR UPDATE`, [connectionId, e.from.id])
    ).rows[0];

    const key = e.type === 'comment.created' ? e.commentId : e.messageId;
    const now = deps.clock.now();
    const seq = Number(conv.last_inbound_seq) + 1;
    const fromSelf = e.from.id === ownAccount || (e.type === 'message.received' && e.isEcho === true);
    const stop = !fromSelf && e.type === 'message.received' && isStopCommand(e.text);
    const preRouted = fromSelf ? Reason.IGNORED_SELF : stop ? Reason.STOP_COMMAND : null;

    const inserted = await c.query(
      `INSERT INTO inbox_events (tenant_id, connection_id, conversation_id, event_type, provider_event_key, seq,
         participant_id, media_id, comment_id, text, occurred_at, received_at, routing_status, routing_outcome, run_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       ON CONFLICT (connection_id, event_type, provider_event_key) DO NOTHING
       RETURNING id`,
      [
        tenantId, connectionId, conv.id, e.type, key, seq, e.from.id,
        e.type === 'comment.created' ? e.mediaId : null,
        e.type === 'comment.created' ? e.commentId : null,
        e.text, e.occurredAt, now,
        preRouted ? 'routed' : 'pending', preRouted, stop ? conv.owner_run_id : null,
      ],
    );
    if (!inserted.rowCount) {
      const existing = await c.query(
        `SELECT id FROM inbox_events WHERE connection_id = $1 AND event_type = $2 AND provider_event_key = $3`,
        [connectionId, e.type, key],
      );
      return { status: 'accepted', eventId: existing.rows[0].id, duplicate: true } as const;
    }
    const eventId: string = inserted.rows[0].id;
    if (e.type === 'comment.created' && !fromSelf) {
      await enqueueOutbox(c, { tenantId, kind: 'metadata.hydrate', idempotencyKey: `metadata:${eventId}`, payload: { eventId } });
    }

    await c.query(
      `UPDATE conversations SET last_inbound_seq = $2,
         last_inbound_dm_at = CASE WHEN $3 THEN greatest(last_inbound_dm_at, least($4::timestamptz, $5::timestamptz)) ELSE last_inbound_dm_at END
       WHERE id = $1`,
      [conv.id, seq, e.type === 'message.received' && !fromSelf, e.occurredAt, now],
    );

    if (fromSelf) {
      await audit(c, { tenantId, conversationId: conv.id, eventId, type: 'event.ignored', reason: Reason.IGNORED_SELF });
    } else if (stop) {
      // Opt-out is applied atomically with accepting the message, so no concurrent step can treat
      // "STOP" as an (invalid) answer and send a clarification after the person asked us to stop.
      await c.query(`UPDATE conversations SET opted_out = true WHERE id = $1`, [conv.id]);
      await audit(c, { tenantId, conversationId: conv.id, eventId, type: 'conversation.opted_out', reason: Reason.STOP_COMMAND });
      if (conv.owner_run_id) {
        await requestRunCancel(c, { tenantId, runId: conv.owner_run_id, reason: Reason.OPTED_OUT, now });
      }
    }
    return { status: 'accepted', eventId, duplicate: false } as const;
  });
}
