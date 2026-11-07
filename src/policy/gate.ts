import type { PoolClient } from 'pg';
import { Reason } from '../domain/reasons';
import { missingCapabilities, type Capabilities, type SendKind } from '../domain/types';

export interface GateContext {
  runId: string;
  connectionId: string;
  conversationId: string;
  kind: SendKind;
  capabilities: Partial<Capabilities>;
  connectionStatus: string;
  sendsPaused: boolean;
  conversation: { opted_out: boolean; human_takeover: boolean; last_inbound_dm_at: Date | null };
  triggerCommentAt: Date;
  now: Date;
}

export type GateDecision =
  | { ok: true }
  | { ok: false; outcome: 'blocked' | 'cancelled' | 'deferred'; reason: string; retryAfterMs?: number; data?: Record<string, unknown> };

/** While an account is paused, sends wait (and re-check this often) instead of failing the run. */
export const PAUSED_RETRY_MS = 60_000;

/**
 * Single choke point every automated send passes through, re-evaluated right before the call
 * (conditions can change while an action waits in a queue). Runs inside the reservation
 * transaction, under the conversation lock. Order matters: cheapest/most decisive first, and the
 * budget is reserved last so a blocked send never consumes it.
 */
export async function checkSendPolicy(c: PoolClient, g: GateContext): Promise<GateDecision> {
  const ctl = (await c.query(`SELECT cancel_requested, cancel_reason FROM run_controls WHERE run_id = $1`, [g.runId])).rows[0];
  if (ctl?.cancel_requested) return { ok: false, outcome: 'cancelled', reason: ctl.cancel_reason ?? Reason.RUN_CANCELLED };
  if (g.conversation.opted_out) return { ok: false, outcome: 'cancelled', reason: Reason.OPTED_OUT };
  if (g.conversation.human_takeover) return { ok: false, outcome: 'cancelled', reason: Reason.HUMAN_TAKEOVER };

  // Pause means "hold", not "fail": in-flight conversations continue after resume / reconnect.
  if (g.sendsPaused) return { ok: false, outcome: 'deferred', reason: Reason.SENDS_PAUSED, retryAfterMs: PAUSED_RETRY_MS };
  if (g.connectionStatus !== 'active') return { ok: false, outcome: 'blocked', reason: Reason.CONNECTION_INACTIVE };

  // An adapter contract that does not state a limit this send depends on forbids the send.
  const missing = missingCapabilities(g.capabilities, g.kind);
  if (missing.length) return { ok: false, outcome: 'blocked', reason: Reason.CAPABILITY_UNKNOWN, data: { missing } };
  const caps = g.capabilities as Capabilities;

  const hours = (ms: number) => ms / 3_600_000;
  if (g.kind === 'private_reply' && hours(g.now.getTime() - g.triggerCommentAt.getTime()) > caps.privateReplyWindowHours) {
    return { ok: false, outcome: 'blocked', reason: Reason.WINDOW_CLOSED };
  }
  if (g.kind === 'dm') {
    const last = g.conversation.last_inbound_dm_at;
    if (!last || hours(g.now.getTime() - last.getTime()) > caps.messagingWindowHours) {
      return { ok: false, outcome: 'blocked', reason: Reason.WINDOW_CLOSED };
    }
  }

  // Per-recipient frequency across all automations: attempts that may have reached the person.
  const recent = await c.query(
    `SELECT count(*)::int AS n FROM message_attempts a JOIN message_intents i ON i.id = a.intent_id
      WHERE i.conversation_id = $1 AND a.started_at > $2::timestamptz - interval '1 hour'
        AND (a.outcome IS NULL OR a.outcome IN ('accepted', 'unknown'))`,
    [g.conversationId, g.now],
  );
  if (recent.rows[0].n >= caps.recipientHourlyLimit) {
    return { ok: false, outcome: 'blocked', reason: Reason.RECIPIENT_LIMIT };
  }

  // Shared account budget: fixed windows in Postgres, shared by every worker. Reserved before the
  // call and not refunded on unknown outcomes (the platform may have counted it).
  const windowMs = caps.budgetWindowSeconds * 1000;
  const windowStart = new Date(Math.floor(g.now.getTime() / windowMs) * windowMs);
  const reserved = await c.query(
    `INSERT INTO send_budget (connection_id, window_start, used) VALUES ($1, $2, 1)
     ON CONFLICT (connection_id, window_start) DO UPDATE SET used = send_budget.used + 1
       WHERE send_budget.used < $3
     RETURNING used`,
    [g.connectionId, windowStart, caps.sendsPerWindow],
  );
  if (!reserved.rowCount) {
    return { ok: false, outcome: 'deferred', reason: Reason.RATE_LIMITED, retryAfterMs: windowStart.getTime() + windowMs - g.now.getTime() };
  }
  return { ok: true };
}
