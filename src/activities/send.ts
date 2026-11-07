import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { SendOutcome } from '../adapters/instagram';
import { raiseIncident, settleUnknownIncident } from '../alerts/incidents';
import type { AutomationDefinition } from '../domain/definition';
import { Reason } from '../domain/reasons';
import { resolveCapabilities, type SendKind, type SendStepResult } from '../domain/types';
import { checkSendPolicy } from '../policy/gate';
import { audit } from '../storage/audit';
import { withTx } from '../storage/db';
import type { ActivityDeps } from './deps';

/**
 * The external-send protocol (see docs/decisions/002-external-send-guarantees.md):
 *
 *   Tx1 (conversation lock): find-or-create the intent; short-circuit on any recorded outcome;
 *        an `in_flight` intent means a previous attempt never recorded its result -> `unknown`;
 *        policy gate; reserve the attempt (pending -> in_flight) and, for a prompt, fix the wait
 *        boundary + deadline. COMMIT.
 *   HTTP (no locks held, no retries inside the adapter).
 *   Tx2: record the attempt; update the intent only if this attempt still owns it (fencing).
 *
 * Every entry - first try, Temporal retry, retry after a worker died - goes through Tx1, so
 * "Instagram accepted -> worker died -> activity retried" can never produce a blind second send.
 */
export async function executeSend(
  deps: ActivityDeps,
  i: { runId: string; stepId: string; actionNo: number },
): Promise<SendStepResult> {
  const reserved = await withTx(deps.db, (c) => reserve(c, deps, i));
  if (reserved.done) return reserved.result;

  const { intent, attemptId, request } = reserved;
  const outcome = await deps.platform.send(request);
  deps.hooks?.afterProviderCall?.(intent.id, i);

  const result = await withTx(deps.db, (c) => record(c, deps, intent, attemptId, outcome));
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
}

type Reservation =
  | { done: true; result: SendStepResult }
  | { done: false; intent: IntentRow; attemptId: string; request: Parameters<ActivityDeps['platform']['send']>[0] };

async function reserve(c: PoolClient, deps: ActivityDeps, i: { runId: string; stepId: string; actionNo: number }): Promise<Reservation> {
  const ctx = (
    await c.query(
      `SELECT r.tenant_id, r.conversation_id, v.definition, e.comment_id, e.occurred_at AS comment_at,
              sc.id AS connection_id, sc.external_account_id, sc.capabilities, sc.status AS connection_status, sc.sends_paused
         FROM automation_runs r
         JOIN automation_versions v ON v.id = r.version_id
         JOIN inbox_events e ON e.id = r.trigger_event_id
         JOIN conversations cv ON cv.id = r.conversation_id
         JOIN social_connections sc ON sc.id = cv.connection_id
        WHERE r.id = $1`,
      [i.runId],
    )
  ).rows[0];
  if (!ctx) throw new Error(`run ${i.runId} not found`);
  const conv = (await c.query(`SELECT * FROM conversations WHERE id = $1 FOR UPDATE`, [ctx.conversation_id])).rows[0];

  // Find or create the logical intent. Its content comes from the run's pinned definition version.
  const spec = intentSpec(ctx.definition as AutomationDefinition, i.stepId, i.actionNo, { commentId: ctx.comment_id, participantId: conv.participant_id });
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
      await c.query(`UPDATE message_intents SET status = 'unknown', status_reason = $2, updated_at = now() WHERE id = $1`, [
        intent.id,
        Reason.ATTEMPT_OUTCOME_LOST,
      ]);
      await audit(c, { ...base, type: 'send.unknown', reason: Reason.ATTEMPT_OUTCOME_LOST, data: { stepId: i.stepId, actionNo: i.actionNo } });
      await raiseIncident(c, { tenantId: intent.tenant_id, connectionId: intent.connection_id, errorClass: 'send_outcome_unknown', runId: i.runId });
      return { done: true, result: { status: 'unknown', intentId: intent.id, reason: Reason.ATTEMPT_OUTCOME_LOST } };
    }
  }

  // Link the prompt to its wait (prepared by the workflow just before this send).
  let waitId = intent.wait_id;
  if (!waitId && i.actionNo === 1) {
    waitId = (await c.query(`SELECT id FROM input_waits WHERE run_id = $1 AND prompt_step_id = $2`, [i.runId, i.stepId])).rows[0]?.id ?? null;
    if (waitId) await c.query(`UPDATE message_intents SET wait_id = $2 WHERE id = $1`, [intent.id, waitId]);
  }

  const now = deps.clock.now();
  const gate = await checkSendPolicy(c, {
    runId: i.runId,
    connectionId: intent.connection_id,
    conversationId: conv.id,
    kind: intent.kind,
    capabilities: resolveCapabilities(ctx.capabilities),
    connectionStatus: ctx.connection_status,
    sendsPaused: ctx.sends_paused,
    conversation: conv,
    triggerCommentAt: new Date(ctx.comment_at),
    now,
  });
  if (!gate.ok) {
    if (gate.outcome === 'deferred') {
      await c.query(`UPDATE message_intents SET status_reason = $2, updated_at = now() WHERE id = $1`, [intent.id, gate.reason]);
      await audit(c, { ...base, type: 'send.deferred', reason: gate.reason, data: { retryAfterMs: gate.retryAfterMs } });
      return { done: true, result: { status: 'deferred', intentId: intent.id, retryAfterMs: gate.retryAfterMs ?? 1000, reason: gate.reason } };
    }
    await c.query(`UPDATE message_intents SET status = $2, status_reason = $3, updated_at = now() WHERE id = $1`, [intent.id, gate.outcome, gate.reason]);
    await audit(c, { ...base, type: `send.${gate.outcome}`, reason: gate.reason, data: { stepId: i.stepId } });
    return { done: true, result: { status: gate.outcome, intentId: intent.id, reason: gate.reason } };
  }

  const attemptNo = intent.attempt_count + 1;
  const attemptId: string = (
    await c.query(`INSERT INTO message_attempts (intent_id, attempt_no, started_at) VALUES ($1, $2, $3) RETURNING id`, [intent.id, attemptNo, now])
  ).rows[0].id;
  await c.query(
    `UPDATE message_intents SET status = 'in_flight', status_reason = NULL, current_attempt_id = $2, attempt_count = $3, updated_at = now() WHERE id = $1`,
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
      accountId: ctx.external_account_id,
      commentId: intent.target.commentId,
      recipientId: intent.target.recipientId,
      text: intent.body,
      clientRef: intent.id,
    },
  };
}

async function record(c: PoolClient, deps: ActivityDeps, intent: IntentRow, attemptId: string, out: SendOutcome): Promise<SendStepResult> {
  const now = deps.clock.now();
  await c.query(
    `UPDATE message_attempts SET finished_at = $2, outcome = $3, http_status = $4, provider_code = $5, provider_message_id = $6 WHERE id = $1`,
    [attemptId, now, out.status, out.httpStatus ?? null, 'code' in out ? out.code : null, out.status === 'accepted' ? out.providerMessageId : null],
  );
  const base = { tenantId: intent.tenant_id, runId: intent.run_id, conversationId: intent.conversation_id, intentId: intent.id };

  const owned = await c.query(`SELECT status FROM message_intents WHERE id = $1 AND current_attempt_id = $2 FOR UPDATE`, [intent.id, attemptId]);
  if (owned.rows[0]?.status !== 'in_flight') {
    // Fenced: another entry already declared this attempt's outcome lost. A provider acceptance of
    // this very attempt is still authoritative evidence and resolves the uncertainty.
    await c.query(`UPDATE message_attempts SET recorded_late = true WHERE id = $1`, [attemptId]);
    if (out.status === 'accepted' && owned.rows[0]?.status === 'unknown') {
      await c.query(
        `UPDATE message_intents SET status = 'accepted', status_reason = NULL, provider_message_id = $2, resolved_by = 'late_result', updated_at = now() WHERE id = $1`,
        [intent.id, out.providerMessageId],
      );
      await audit(c, { ...base, type: 'send.resolved', reason: 'late_result', data: { providerMessageId: out.providerMessageId } });
      await settleUnknownIncident(c, { tenantId: intent.tenant_id, connectionId: intent.connection_id });
      return { status: 'accepted', intentId: intent.id, providerMessageId: out.providerMessageId };
    }
    await audit(c, { ...base, type: 'send.late_result_ignored', data: { outcome: out.status } });
    const current = (await c.query(`SELECT status, status_reason FROM message_intents WHERE id = $1`, [intent.id])).rows[0];
    return { status: 'unknown', intentId: intent.id, reason: current.status_reason ?? Reason.ATTEMPT_OUTCOME_LOST };
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
        // Stop every automation on this account until it is reconnected.
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
        `UPDATE message_intents SET status = 'pending', status_reason = $2, current_attempt_id = NULL, updated_at = now() WHERE id = $1`,
        [intent.id, Reason.PROVIDER_THROTTLED],
      );
      await audit(c, { ...base, type: 'send.deferred', reason: Reason.PROVIDER_THROTTLED, data: { providerCode: out.code, retryAfterMs: out.retryAfterMs } });
      return { status: 'deferred', intentId: intent.id, retryAfterMs: out.retryAfterMs, reason: Reason.PROVIDER_THROTTLED };

    case 'unknown':
      await c.query(`UPDATE message_intents SET status = 'unknown', status_reason = $2, updated_at = now() WHERE id = $1`, [intent.id, Reason.PROVIDER_TIMEOUT]);
      await audit(c, { ...base, type: 'send.unknown', reason: Reason.PROVIDER_TIMEOUT, data: { providerCode: out.code } });
      await raiseIncident(c, { tenantId: intent.tenant_id, connectionId: intent.connection_id, errorClass: 'send_outcome_unknown', runId: intent.run_id });
      return { status: 'unknown', intentId: intent.id, reason: Reason.PROVIDER_TIMEOUT };
  }
}

/**
 * Recovery for `unknown` intents: only authoritative evidence counts. A lookup by our client
 * reference (when the adapter contract supports it) or a prior operator decision. Matching text and
 * timestamps is not proof of identity, so absence of evidence leaves the intent unresolved.
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

  const caps = resolveCapabilities(row.capabilities);
  if (caps.reconciliation !== 'lookup_by_client_ref' || !deps.platform.lookupByClientRef) return { status: 'unresolved' };
  const found = await deps.platform.lookupByClientRef(row.external_account_id, row.id);
  if (!found.found) return { status: 'unresolved' };

  return withTx(deps.db, async (c) => {
    const r = await c.query(
      `UPDATE message_intents SET status = 'accepted', status_reason = NULL, provider_message_id = $2, resolved_by = 'reconciliation', updated_at = now()
        WHERE id = $1 AND status = 'unknown'`,
      [row.id, found.providerMessageId],
    );
    if (r.rowCount) {
      await audit(c, {
        tenantId: row.tenant_id, runId: row.run_id, conversationId: row.conversation_id, intentId: row.id,
        type: 'send.resolved', reason: 'reconciliation', data: { providerMessageId: found.providerMessageId },
      });
      await settleUnknownIncident(c, { tenantId: row.tenant_id, connectionId: row.connection_id });
    }
    return { status: 'accepted' as const };
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
