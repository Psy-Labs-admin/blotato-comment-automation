import { extractEmail } from '../domain/matching';
import { Reason } from '../domain/reasons';
import type { WaitEvaluation } from '../domain/types';
import { audit } from '../storage/audit';
import { withTx } from '../storage/db';
import { enqueueOutbox } from '../storage/outbox';
import type { ActivityDeps } from './deps';

/**
 * Creates the wait before its question is sent (idempotent per run+step). Boundary and deadline are
 * still empty: the send ledger fixes them when the first prompt attempt is reserved.
 */
export async function prepareWait(
  deps: ActivityDeps,
  i: { runId: string; stepId: string; promptStepId: string; timeoutMs: number; maxClarifications: number },
): Promise<{ waitId: string }> {
  await deps.db.query(
    `INSERT INTO input_waits (tenant_id, run_id, step_id, prompt_step_id, conversation_id, status, timeout_ms, max_clarifications)
     SELECT tenant_id, id, $2, $3, conversation_id, 'prepared', $4, $5 FROM automation_runs WHERE id = $1
     ON CONFLICT (run_id, step_id) DO NOTHING`,
    [i.runId, i.stepId, i.promptStepId, i.timeoutMs, i.maxClarifications],
  );
  const r = await deps.db.query(`SELECT id FROM input_waits WHERE run_id = $1 AND step_id = $2`, [i.runId, i.stepId]);
  return { waitId: r.rows[0].id };
}

/** The question was accepted by the platform: replies after the boundary may now be consumed. */
export async function activateWait(deps: ActivityDeps, i: { waitId: string }): Promise<void> {
  await withTx(deps.db, async (c) => {
    const w = (await c.query(`UPDATE input_waits SET status = 'active' WHERE id = $1 AND status = 'prepared' RETURNING *`, [i.waitId])).rows[0];
    if (!w) return;
    await c.query(`UPDATE automation_runs SET status = 'waiting_input', current_step = $2, updated_at = now() WHERE id = $1 AND finished_at IS NULL`, [
      w.run_id,
      w.step_id,
    ]);
    await audit(c, {
      tenantId: w.tenant_id, runId: w.run_id, conversationId: w.conversation_id, type: 'wait.active',
      data: { stepId: w.step_id, deadline: w.deadline },
    });
  });
}

/**
 * The single place that decides what inbound messages mean for a wait. Runs under the conversation
 * lock, so it serialises with ingestion (sequence numbers), the prompt boundary and other
 * evaluations. Idempotent: a recorded decision is returned again on retry; each inbound event is
 * evaluated at most once (input_consumptions PK), including invalid answers.
 *
 * Called on every wake-up (signal or timer). It reads the inbox itself, so lost, duplicated or
 * reordered signals cannot change the outcome; on timer expiry it still consumes an answer that
 * was durably received before the deadline.
 */
export async function evaluateWait(deps: ActivityDeps, i: { waitId: string }): Promise<WaitEvaluation> {
  return withTx(deps.db, async (c) => {
    const head = await c.query(`SELECT conversation_id FROM input_waits WHERE id = $1`, [i.waitId]);
    if (!head.rowCount) throw new Error(`wait ${i.waitId} not found`);
    const conv = (await c.query(`SELECT * FROM conversations WHERE id = $1 FOR UPDATE`, [head.rows[0].conversation_id])).rows[0];
    const w = (await c.query(`SELECT * FROM input_waits WHERE id = $1 FOR UPDATE`, [i.waitId])).rows[0];
    const base = { tenantId: w.tenant_id, runId: w.run_id, conversationId: conv.id };

    if (w.status === 'consumed') return { kind: 'valid', leadId: w.lead_id };
    if (w.status === 'expired') return { kind: 'expired' };

    const ctl = (await c.query(`SELECT cancel_requested, cancel_reason FROM run_controls WHERE run_id = $1`, [w.run_id])).rows[0];
    const cancelReason = ctl?.cancel_requested ? ctl.cancel_reason ?? Reason.RUN_CANCELLED
      : conv.opted_out ? Reason.OPTED_OUT
      : conv.human_takeover ? Reason.HUMAN_TAKEOVER
      : null;
    if (w.status === 'cancelled' || cancelReason) {
      if (w.status !== 'cancelled') {
        await c.query(`UPDATE input_waits SET status = 'cancelled', closed_at = $2 WHERE id = $1`, [w.id, deps.clock.now()]);
        await audit(c, { ...base, type: 'wait.cancelled', reason: cancelReason });
      }
      return { kind: 'cancelled', reason: cancelReason ?? Reason.RUN_CANCELLED };
    }

    const now = deps.clock.now();
    if (w.status !== 'active' || !w.deadline) {
      // Prompt not confirmed yet: replies stay stored, nothing is consumed.
      return { kind: 'waiting', msUntilDeadline: w.deadline ? Math.max(0, new Date(w.deadline).getTime() - now.getTime()) : w.timeout_ms };
    }
    const pastDeadline = now.getTime() >= new Date(w.deadline).getTime();

    // A clarification already decided but not yet confirmed sent is returned again (retry-safe),
    // unless the deadline passed: no clarification goes out after the deadline.
    const owed = pastDeadline ? null : await owedClarification(c, w);
    if (owed) return { kind: 'clarify', actionNo: owed };

    const candidates = (
      await c.query(
        `SELECT e.id, e.text FROM inbox_events e
           LEFT JOIN input_consumptions ic ON ic.inbox_event_id = e.id
          WHERE e.conversation_id = $1 AND e.event_type = 'message.received' AND ic.inbox_event_id IS NULL
            AND e.seq > $2 AND e.received_at <= $3
            AND e.routing_outcome IS DISTINCT FROM $4 AND e.routing_outcome IS DISTINCT FROM $5
          ORDER BY e.seq`,
        [conv.id, w.boundary_seq, w.deadline, Reason.IGNORED_SELF, Reason.STOP_COMMAND],
      )
    ).rows.map((ev) => ({ ...ev, parsed: extractEmail(ev.text) }));

    const rejectInput = async (ev: (typeof candidates)[number]) => {
      const result = ev.parsed.kind === 'ambiguous' ? 'ambiguous' : 'invalid';
      await c.query(`INSERT INTO input_consumptions (inbox_event_id, wait_id, tenant_id, result) VALUES ($1, $2, $3, $4)`, [
        ev.id, w.id, w.tenant_id, result,
      ]);
      await audit(c, { ...base, eventId: ev.id, type: 'input.rejected', reason: result === 'ambiguous' ? Reason.EMAIL_AMBIGUOUS : Reason.EMAIL_INVALID });
    };

    // Look at the whole backlog first: if a valid email is already there, it is the answer, and the
    // earlier unusable messages do not earn the person a "that doesn't look like an email" DM.
    const validIdx = candidates.findIndex((ev) => ev.parsed.kind === 'valid');
    if (validIdx >= 0) {
      for (const ev of candidates.slice(0, validIdx)) await rejectInput(ev);
      const ev = candidates[validIdx];
      const email = (ev.parsed as { kind: 'valid'; email: string }).email;
      await c.query(`INSERT INTO input_consumptions (inbox_event_id, wait_id, tenant_id, result) VALUES ($1, $2, $3, 'valid')`, [
        ev.id, w.id, w.tenant_id,
      ]);
      const leadId: string = (
        await c.query(
          `INSERT INTO leads (tenant_id, connection_id, conversation_id, participant_id, run_id, source_event_id, email)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
          [w.tenant_id, conv.connection_id, conv.id, conv.participant_id, w.run_id, ev.id, email],
        )
      ).rows[0].id;
      await c.query(`UPDATE input_waits SET status = 'consumed', consumed_event_id = $2, lead_id = $3, closed_at = $4 WHERE id = $1`, [
        w.id, ev.id, leadId, now,
      ]);
      // CRM sync is a separate, independently retried delivery: a CRM outage never blocks the DM.
      await enqueueOutbox(c, { tenantId: w.tenant_id, kind: 'crm.lead_captured', idempotencyKey: `lead:${leadId}`, payload: { leadId } });
      await audit(c, { ...base, eventId: ev.id, type: 'input.accepted', reason: Reason.EMAIL_VALID, data: { leadId } });
      deps.onOutbox?.();
      return { kind: 'valid', leadId };
    }

    for (const ev of candidates) await rejectInput(ev);
    if (candidates.length && !pastDeadline && w.clarifications_used < w.max_clarifications) {
      const used = w.clarifications_used + 1;
      await c.query(`UPDATE input_waits SET clarifications_used = $2 WHERE id = $1`, [w.id, used]);
      await audit(c, { ...base, type: 'input.clarification_requested', data: { clarification: used } });
      return { kind: 'clarify', actionNo: used + 1 };
    }

    if (pastDeadline) {
      await c.query(`UPDATE input_waits SET status = 'expired', closed_at = $2 WHERE id = $1`, [w.id, now]);
      await audit(c, { ...base, type: 'wait.expired', reason: Reason.DEADLINE_PASSED });
      return { kind: 'expired' };
    }
    return { kind: 'waiting', msUntilDeadline: new Date(w.deadline).getTime() - now.getTime() };
  });
}

/** clarifications_used = n means clarification n (actionNo n+1) is owed until its intent reaches an outcome. */
async function owedClarification(c: import('pg').PoolClient, w: any): Promise<number | null> {
  if (w.clarifications_used === 0) return null;
  const actionNo = w.clarifications_used + 1;
  const intent = (
    await c.query(`SELECT status FROM message_intents WHERE run_id = $1 AND step_id = $2 AND action_no = $3`, [w.run_id, w.step_id, actionNo])
  ).rows[0];
  if (!intent || intent.status === 'pending' || intent.status === 'in_flight') return actionNo;
  return null;
}
