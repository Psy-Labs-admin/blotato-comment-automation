import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { SendOutcome } from '../adapters/instagram';
import { raiseIncident, settleUnknownIncident } from '../alerts/incidents';
import type { AutomationDefinition } from '../domain/definition';
import { Reason } from '../domain/reasons';
import { parseCapabilities, type SendKind, type SendStepResult } from '../domain/types';
import { checkSendPolicy } from '../policy/gate';
import { audit } from '../storage/audit';
import { withTx } from '../storage/db';
import type { ActivityDeps } from './deps';
import { onIntentSettled } from './runs';

/**
 * The external-send protocol (see docs/decisions/002-external-send-guarantees.md):
 *
 *   Tx1 (conversation lock): find-or-create the intent; short-circuit on any recorded outcome;
 *        an `in_flight` intent means a previous attempt never recorded its result -> `unknown`;
 *        deadline + policy gate; reserve the attempt (pending -> in_flight) and, for a prompt,
 *        fix the wait boundary + deadline. COMMIT.
 *   HTTP (no locks held, no retries inside the adapter).
 *   Tx2 (conversation lock, then intent): record the attempt; update the intent only if this
 *        attempt still owns it (fencing). A late acceptance of a fenced attempt is evidence: it
 *        settles the intent and wakes the run (or releases the conversation of a finished run).
 *
 * Lock order everywhere: conversation -> intent -> incident.
 * Every entry - first try, Temporal retry, retry after a worker died - goes through Tx1, so
 * "Instagram accepted -> worker died -> activity retried" can never produce a blind second send.
 */
export async function executeSend(
  deps: ActivityDeps,
  i: { runId: string; stepId: string; actionNo: number },
): Promise<SendStepResult> {
  const reserved = await withTx(deps.db, (c) => reserve(c, deps, i));
  if (reserved.done) {
    if (reserved.poke) deps.onOutbox?.();
    return reserved.result;
  }

  const { intent, attemptId, request } = reserved;
  const outcome = await deps.platform.send(request);
  deps.hooks?.afterProviderCall?.(intent.id, i);

  const result = await withTx(deps.db, (c) => record(c, deps, intent, attemptId, outcome));
  deps.onOutbox?.();
  deps.hooks?.afterResultCommit?.(intent.id, i);
  return result;
}

interface IntentRow {
  id: string;
  tenant_id: string;
  run_id: string;
  step_id: string;
  action_no: number;
  connection_id: string;
  conversation_id: string;
  kind: SendKind;
  target: { commentId?: string; recipientId?: string };
  body: string;
  status: string;
  status_reason: string | null;
  current_attempt_id: string | null;
  attempt_count: number;
  provider_message_id: string | null;
  wait_id: string | null;
  next_attempt_at: Date | null;
}

type Reservation =
  | { done: true; result: SendStepResult; poke?: boolean }
  | { done: false; intent: IntentRow; attemptId: string; request: Parameters<ActivityDeps['platform']['send']>[0] };

async function reserve(c: PoolClient, deps: ActivityDeps, i: { runId: string; stepId: string; actionNo: number }): Promise<Reservation> {
  const head = (await c.query(`SELECT conversation_id FROM automation_runs WHERE id = $1`, [i.runId])).rows[0];
  if (!head) throw new Error(`run ${i.runId} not found`);
  const conv = (await c.query(`SELECT * FROM conversations WHERE id = $1 FOR UPDATE`, [head.conversation_id])).rows[0];
  // Read the run and account after acquiring the lock. Finalization or an account control may
  // have committed while this activity waited for another operation on this conversation.
  const ctx = (
    await c.query(
      `SELECT r.tenant_id, r.conversation_id, r.finished_at, v.definition, e.comment_id, least(e.occurred_at, e.received_at) AS comment_at,
              e.connection_id
         FROM automation_runs r
         JOIN automation_versions v ON v.id = r.version_id
         JOIN inbox_events e ON e.id = r.trigger_event_id
        WHERE r.id = $1`,
      [i.runId],
    )
  ).rows[0];

  // Find or create the logical intent. Its content comes from the run's pinned definition version.
  const def = ctx.definition as AutomationDefinition;
  const spec = intentSpec(def, i.stepId, i.actionNo, { commentId: ctx.comment_id, participantId: conv.participant_id });
  const fingerprint = createHash('sha256').update(JSON.stringify([spec.kind, spec.target, spec.body])).digest('hex');
  await c.query(
    `INSERT INTO message_intents (tenant_id, run_id, step_id, action_no, connection_id, conversation_id, kind, target, body, fingerprint)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (run_id, step_id, action_no) DO NOTHING`,
    [ctx.tenant_id, i.runId, i.stepId, i.actionNo, ctx.connection_id, conv.id, spec.kind, spec.target, spec.body, fingerprint],
  );
  const intent: IntentRow = (
    await c.query(`SELECT * FROM message_intents WHERE run_id = $1 AND step_id = $2 AND action_no = $3 FOR UPDATE`, [i.runId, i.stepId, i.actionNo])
  ).rows[0];
  const base = { tenantId: intent.tenant_id, runId: i.runId, conversationId: conv.id, intentId: intent.id };

  switch (intent.status) {
    case 'accepted':
      return { done: true, result: { status: 'accepted', intentId: intent.id, providerMessageId: intent.provider_message_id } };
    case 'unknown':
      return { done: true, result: { status: 'unknown', intentId: intent.id, reason: intent.status_reason ?? Reason.ATTEMPT_OUTCOME_LOST } };
    case 'rejected':
    case 'blocked':
    case 'cancelled':
      return { done: true, result: { status: intent.status, intentId: intent.id, reason: intent.status_reason ?? intent.status } };
    case 'in_flight': {
      // A previous attempt reserved the send and never recorded a result: the worker died, timed
      // out, or is still waiting on the network. The message may have been delivered.
      await markUnknown(c, intent, Reason.ATTEMPT_OUTCOME_LOST);
      return { done: true, poke: true, result: { status: 'unknown', intentId: intent.id, reason: Reason.ATTEMPT_OUTCOME_LOST } };
    }
  }

  // Link the prompt to its wait (prepared by the workflow just before this send).
  let waitId = intent.wait_id;
  if (!waitId && i.actionNo === 1) {
    waitId = (await c.query(`SELECT id FROM input_waits WHERE run_id = $1 AND prompt_step_id = $2`, [i.runId, i.stepId])).rows[0]?.id ?? null;
    if (waitId) await c.query(`UPDATE message_intents SET wait_id = $2 WHERE id = $1`, [intent.id, waitId]);
  }

  const block = async (outcome: 'blocked' | 'cancelled', reason: string, data: Record<string, unknown> = {}): Promise<Reservation> => {
    await c.query(`UPDATE message_intents SET status = $2, status_reason = $3, updated_at = now() WHERE id = $1`, [intent.id, outcome, reason]);
    await audit(c, { ...base, type: `send.${outcome}`, reason, data: { stepId: i.stepId, ...data } });
    return { done: true, result: { status: outcome, intentId: intent.id, reason } };
  };

  // An activity can outlive the workflow that scheduled it. Preserve recorded outcomes above,
  // but never reserve new effects after finalization or after ownership has changed.
  if (ctx.finished_at) return block('cancelled', Reason.RUN_FINISHED);
  if (conv.owner_run_id !== i.runId) return block('cancelled', Reason.CONVERSATION_OWNERSHIP_LOST);

  // A pause and a new reservation must have a definite order. Hold the account lock
  // until the reservation commits. Account budgets are shared. The lock ends before any provider I/O.
  const account = (await c.query(
    'SELECT external_account_id, capabilities, status, sends_paused FROM social_connections WHERE id = $1 FOR NO KEY UPDATE',
    [ctx.connection_id],
  )).rows[0];
  const now = deps.clock.now();
  // A question or clarification after its wait's deadline is pointless (and confusing): never send it.
  const waitDeadline = (
    await c.query(
      `SELECT deadline FROM input_waits WHERE run_id = $1 AND (id = $2 OR (step_id = $3 AND $4 > 1)) AND deadline IS NOT NULL LIMIT 1`,
      [i.runId, waitId, i.stepId, i.actionNo],
    )
  ).rows[0]?.deadline as Date | undefined;
  if (waitDeadline && now.getTime() >= waitDeadline.getTime()) return block('blocked', Reason.DEADLINE_PASSED);

  const gate = await checkSendPolicy(c, {
    runId: i.runId,
    connectionId: intent.connection_id,
    conversationId: conv.id,
    kind: intent.kind,
    capabilities: parseCapabilities(account.capabilities),
    connectionStatus: account.status,
    sendsPaused: account.sends_paused,
    conversation: conv,
    triggerCommentAt: new Date(ctx.comment_at),
    nextAttemptAt: intent.next_attempt_at,
    now,
  });
  if (!gate.ok) {
    if (gate.outcome === 'deferred') {
      await c.query(`UPDATE message_intents SET status_reason = $2, updated_at = now() WHERE id = $1`, [intent.id, gate.reason]);
      await audit(c, { ...base, type: 'send.deferred', reason: gate.reason, data: { retryAfterMs: gate.retryAfterMs } });
      return { done: true, result: { status: 'deferred', intentId: intent.id, retryAfterMs: gate.retryAfterMs ?? 1000, reason: gate.reason } };
    }
    return block(gate.outcome, gate.reason, gate.data);
  }

  const attemptNo = intent.attempt_count + 1;
  const attemptId: string = (
    await c.query(`INSERT INTO message_attempts (intent_id, attempt_no, started_at) VALUES ($1, $2, $3) RETURNING id`, [intent.id, attemptNo, now])
  ).rows[0].id;
  await c.query(
    `UPDATE message_intents SET status = 'in_flight', status_reason = NULL, current_attempt_id = $2, attempt_count = $3, next_attempt_at = NULL, updated_at = now() WHERE id = $1`,
    [intent.id, attemptId, attemptNo],
  );
  if (waitId) {
    // Fixed once, before the first attempt leaves: messages already in the inbox cannot answer this
    // question, and retries/recovery never extend the deadline.
    await c.query(
      `UPDATE input_waits SET boundary_seq = $2, prompt_started_at = $3, deadline = $3::timestamptz + make_interval(secs => timeout_ms / 1000.0)
        WHERE id = $1 AND prompt_started_at IS NULL`,
      [waitId, conv.last_inbound_seq, now],
    );
  }
  await c.query(
    `UPDATE automation_runs SET current_step = $2, status = CASE WHEN status = 'starting' THEN 'running' ELSE status END, updated_at = now() WHERE id = $1`,
    [i.runId, i.stepId],
  );
  await audit(c, { ...base, type: 'send.attempt_started', data: { stepId: i.stepId, actionNo: i.actionNo, attemptNo, kind: intent.kind } });

  return {
    done: false,
    intent: { ...intent, wait_id: waitId },
    attemptId,
    request: {
      kind: intent.kind,
      accountId: account.external_account_id,
      commentId: intent.target.commentId,
      recipientId: intent.target.recipientId,
      text: intent.body,
      clientRef: intent.id,
    },
  };
}

/** Declares an attempt's outcome lost: held conversation, incident, no automatic resend. */
export async function markUnknown(c: PoolClient, intent: { id: string; tenant_id: string; run_id: string; conversation_id: string; connection_id: string; step_id: string; action_no: number }, reason: string) {
  await c.query(`UPDATE message_intents SET status = 'unknown', status_reason = $2, updated_at = now() WHERE id = $1`, [intent.id, reason]);
  await audit(c, {
    tenantId: intent.tenant_id, runId: intent.run_id, conversationId: intent.conversation_id, intentId: intent.id,
    type: 'send.unknown', reason, data: { stepId: intent.step_id, actionNo: intent.action_no },
  });
  await raiseIncident(c, { tenantId: intent.tenant_id, connectionId: intent.connection_id, errorClass: 'send_outcome_unknown', runId: intent.run_id });
}

async function record(c: PoolClient, deps: ActivityDeps, reserved: IntentRow, attemptId: string, out: SendOutcome): Promise<SendStepResult> {
  const now = deps.clock.now();
  // Same lock order as Tx1 (conversation, then intent): no deadlock with a concurrent re-entry.
  await c.query(`SELECT 1 FROM conversations WHERE id = $1 FOR UPDATE`, [reserved.conversation_id]);
  const intent: IntentRow = (await c.query(`SELECT * FROM message_intents WHERE id = $1 FOR UPDATE`, [reserved.id])).rows[0];
  await c.query(
    `UPDATE message_attempts SET finished_at = $2, outcome = $3, http_status = $4, provider_code = $5, provider_message_id = $6 WHERE id = $1`,
    [attemptId, now, out.status, out.httpStatus ?? null, 'code' in out ? out.code : null, out.status === 'accepted' ? out.providerMessageId : null],
  );
  const base = { tenantId: intent.tenant_id, runId: intent.run_id, conversationId: intent.conversation_id, intentId: intent.id };

  const ownsIntent = intent.status === 'in_flight' && intent.current_attempt_id === attemptId;
  if (!ownsIntent) {
    // Fenced: another entry already declared this attempt's outcome lost, or an operator decided
    // it was not sent. A provider acceptance of this very attempt is authoritative evidence.
    await c.query(`UPDATE message_attempts SET recorded_late = true WHERE id = $1`, [attemptId]);
    if (out.status === 'accepted' && (intent.status === 'unknown' || intent.status === 'pending')) {
      const contradicted = intent.status === 'pending';
      await c.query(
        `UPDATE message_intents SET status = 'accepted', status_reason = NULL, current_attempt_id = $3, provider_message_id = $2,
                resolved_by = 'late_result', updated_at = now() WHERE id = $1`,
        [intent.id, out.providerMessageId, attemptId],
      );
      await audit(c, {
        ...base, type: 'send.resolved', reason: 'late_result',
        data: { providerMessageId: out.providerMessageId, contradictsOperatorNotSent: contradicted || undefined },
      });
      await settleUnknownIncident(c, { tenantId: intent.tenant_id, connectionId: intent.connection_id });
      await onIntentSettled(c, { intentId: intent.id, runId: intent.run_id, tenantId: intent.tenant_id }, now, 'late');
      return { status: 'accepted', intentId: intent.id, providerMessageId: out.providerMessageId };
    }
    await audit(c, { ...base, type: 'send.late_result_ignored', data: { outcome: out.status, intentStatus: intent.status } });
    if (intent.status === 'accepted') return { status: 'accepted', intentId: intent.id, providerMessageId: intent.provider_message_id };
    return { status: 'unknown', intentId: intent.id, reason: intent.status_reason ?? Reason.ATTEMPT_OUTCOME_LOST };
  }

  switch (out.status) {
    case 'accepted':
      await c.query(
        `UPDATE message_intents SET status = 'accepted', provider_message_id = $2, resolved_by = 'provider', updated_at = now() WHERE id = $1`,
        [intent.id, out.providerMessageId],
      );
      await audit(c, { ...base, type: 'send.accepted', data: { stepId: intent.step_id, actionNo: intent.action_no, providerMessageId: out.providerMessageId } });
      return { status: 'accepted', intentId: intent.id, providerMessageId: out.providerMessageId };

    case 'rejected': {
      const unauthorized = out.code === 'unauthorized';
      const reason = unauthorized ? Reason.PROVIDER_UNAUTHORIZED : Reason.PROVIDER_REJECTED;
      await c.query(`UPDATE message_intents SET status = 'rejected', status_reason = $2, updated_at = now() WHERE id = $1`, [intent.id, reason]);
      await audit(c, { ...base, type: 'send.rejected', reason, data: { providerCode: out.code, httpStatus: out.httpStatus } });
      if (unauthorized) {
        // Stop every automation on this account until it is reconnected (in-flight runs defer).
        await c.query(
          `UPDATE social_connections SET status = 'unauthorized', sends_paused = true, sends_paused_reason = $2 WHERE id = $1`,
          [intent.connection_id, Reason.PROVIDER_UNAUTHORIZED],
        );
        await raiseIncident(c, { tenantId: intent.tenant_id, connectionId: intent.connection_id, errorClass: 'connection_unauthorized', runId: intent.run_id });
      }
      return { status: 'rejected', intentId: intent.id, reason };
    }

    case 'not_sent':
      // Provably no effect: the same intent may be attempted again later.
      await c.query(
        `UPDATE message_intents SET status = 'pending', status_reason = $2, current_attempt_id = NULL, next_attempt_at = $3, updated_at = now() WHERE id = $1`,
        [intent.id, Reason.PROVIDER_THROTTLED, new Date(now.getTime() + out.retryAfterMs)],
      );
      await audit(c, { ...base, type: 'send.deferred', reason: Reason.PROVIDER_THROTTLED, data: { providerCode: out.code, retryAfterMs: out.retryAfterMs } });
      return { status: 'deferred', intentId: intent.id, retryAfterMs: out.retryAfterMs, reason: Reason.PROVIDER_THROTTLED };

    case 'unknown': {
      await c.query(`UPDATE message_intents SET status = 'unknown', status_reason = $2, updated_at = now() WHERE id = $1`, [
        intent.id,
        Reason.PROVIDER_NO_CONFIRMATION,
      ]);
      await audit(c, { ...base, type: 'send.unknown', reason: Reason.PROVIDER_NO_CONFIRMATION, data: { providerCode: out.code } });
      await raiseIncident(c, { tenantId: intent.tenant_id, connectionId: intent.connection_id, errorClass: 'send_outcome_unknown', runId: intent.run_id });
      return { status: 'unknown', intentId: intent.id, reason: Reason.PROVIDER_NO_CONFIRMATION };
    }
  }
}

/**
 * Recovery for `unknown` intents: only authoritative evidence counts. A lookup by our client
 * reference (when the adapter contract supports it), a late result, or an operator decision.
 * Matching text and timestamps is not proof of identity, and a failing or empty lookup is not
 * proof of non-delivery: both leave the intent unresolved.
 */
export async function reconcileIntent(deps: ActivityDeps, i: { intentId: string }): Promise<{ status: 'accepted' | 'retry_allowed' | 'unresolved' }> {
  const row = (
    await deps.db.query(
      `SELECT i.*, sc.capabilities, sc.external_account_id FROM message_intents i
         JOIN social_connections sc ON sc.id = i.connection_id WHERE i.id = $1`,
      [i.intentId],
    )
  ).rows[0];
  if (!row) throw new Error(`intent ${i.intentId} not found`);
  if (row.status === 'accepted') return { status: 'accepted' };
  if (row.status === 'pending') return { status: 'retry_allowed' };
  if (row.status !== 'unknown') return { status: 'unresolved' };

  const reconciliation = parseCapabilities(row.capabilities).reconciliation ?? 'none';
  if (reconciliation !== 'lookup_by_client_ref' || !deps.platform.lookupByClientRef) return { status: 'unresolved' };
  let found: Awaited<ReturnType<NonNullable<typeof deps.platform.lookupByClientRef>>>;
  try {
    found = await deps.platform.lookupByClientRef(row.external_account_id, row.id);
  } catch {
    return { status: 'unresolved' }; // provider outage: stay visible and retry on the next re-check
  }
  if (!found.found) return { status: 'unresolved' };
  const providerMessageId = found.providerMessageId;

  return withTx(deps.db, async (c) => {
    await c.query(`SELECT 1 FROM conversations WHERE id = $1 FOR UPDATE`, [row.conversation_id]);
    const r = await c.query(
      `UPDATE message_intents SET status = 'accepted', status_reason = NULL, provider_message_id = $2, resolved_by = 'reconciliation', updated_at = now()
        WHERE id = $1 AND status IN ('unknown', 'pending')`,
      [row.id, providerMessageId],
    );
    if (r.rowCount) {
      await audit(c, {
        tenantId: row.tenant_id, runId: row.run_id, conversationId: row.conversation_id, intentId: row.id,
        type: 'send.resolved', reason: 'reconciliation', data: { providerMessageId },
      });
      await settleUnknownIncident(c, { tenantId: row.tenant_id, connectionId: row.connection_id });
      await onIntentSettled(c, { intentId: row.id, runId: row.run_id, tenantId: row.tenant_id }, deps.clock.now(), 'reconciliation');
    }
    const current = (await c.query(`SELECT status FROM message_intents WHERE id = $1`, [row.id])).rows[0];
    if (current.status === 'accepted') return { status: 'accepted' as const };
    if (current.status === 'pending') return { status: 'retry_allowed' as const };
    return { status: 'unresolved' as const };
  });
}

function intentSpec(
  def: AutomationDefinition,
  stepId: string,
  actionNo: number,
  ctx: { commentId: string | null; participantId: string },
): { kind: SendKind; target: { commentId?: string; recipientId?: string }; body: string } {
  const step = def.steps.find((s) => s.id === stepId);
  if (!step) throw new Error(`step ${stepId} not in definition`);
  switch (step.type) {
    case 'reply_comment':
      return { kind: 'comment_reply', target: { commentId: ctx.commentId! }, body: step.text };
    case 'send_private_reply':
      return { kind: 'private_reply', target: { commentId: ctx.commentId! }, body: step.text };
    case 'send_message':
      return { kind: 'dm', target: { recipientId: ctx.participantId }, body: step.text };
    case 'await_input':
      if (actionNo < 2) throw new Error(`await_input step ${stepId} sends only clarifications (actionNo >= 2)`);
      return { kind: 'dm', target: { recipientId: ctx.participantId }, body: step.clarificationText };
  }
}
