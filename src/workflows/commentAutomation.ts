import { condition, defineSignal, proxyActivities, setHandler } from '@temporalio/workflow';
import type { Activities } from '../activities';
import type { AutomationDefinition, AwaitInput } from '../domain/definition';
import { parseDuration } from '../domain/duration';
import type { RunOutcome } from '../domain/types';

/**
 * One workflow per automation run. It owns *ordering and time*: which step is next, durable
 * waiting, deadlines, bounded retries. It never decides facts on its own: every decision that
 * must survive races (was this sent? which message is the answer? is the deadline over?) is taken
 * by an idempotent activity under the conversation lock in Postgres.
 *
 * Signals are wake-ups, not data: losing, duplicating or reordering them cannot change an outcome
 * because the activity re-reads the inbox. Deterministic: no I/O, no Date.now() decisions here.
 */

export const inboxChanged = defineSignal('inboxChanged');
export const cancelRequested = defineSignal<[{ reason?: string }]>('cancelRequested');
export const intentResolved = defineSignal<[{ intentId: string }]>('intentResolved');

const store = proxyActivities<Activities>({
  startToCloseTimeout: '20s',
  retry: { initialInterval: '200ms', backoffCoefficient: 2, maximumInterval: '10s', maximumAttempts: 20 },
});

// Retrying a send activity is safe *only* because every entry re-checks the ledger first: an attempt
// whose outcome was lost becomes `unknown` and is never blindly re-sent.
const sender = proxyActivities<Pick<Activities, 'executeSend' | 'reconcileIntent'>>({
  startToCloseTimeout: '30s',
  retry: { initialInterval: '300ms', backoffCoefficient: 2, maximumInterval: '5s', maximumAttempts: 3 },
});

const MAX_DEFERRALS = 8;

export interface CommentAutomationInput {
  runId: string;
  /** The pinned, immutable version this run executes (later edits never change a running run). */
  definition: AutomationDefinition;
}

type StepResult = { ok: true } | { ok: false; outcome: RunOutcome; reason: string };

export async function commentAutomation(input: CommentAutomationInput): Promise<RunOutcome> {
  const { runId, definition } = input;
  let inboxDirty = false;
  let cancelReason: string | null = null;
  const resolvedIntents = new Set<string>();

  setHandler(inboxChanged, () => {
    inboxDirty = true;
  });
  setHandler(cancelRequested, ({ reason }) => {
    cancelReason = reason ?? 'run_cancelled';
  });
  setHandler(intentResolved, ({ intentId }) => {
    resolvedIntents.add(intentId);
  });

  async function finish(outcome: RunOutcome, reason?: string): Promise<RunOutcome> {
    await store.finalizeRun({ runId, outcome, reason });
    return outcome;
  }

  /** Sends one logical action through the ledger, handling deferral and uncertainty. */
  async function send(stepId: string, actionNo: number): Promise<StepResult> {
    let deferrals = 0;
    for (;;) {
      const r = await sender.executeSend({ runId, stepId, actionNo });
      switch (r.status) {
        case 'accepted':
          return { ok: true };
        case 'deferred':
          if (++deferrals > MAX_DEFERRALS) return { ok: false, outcome: 'failed', reason: 'deferral_budget_exhausted' };
          // Durable timer; a cancel wakes us early and the next executeSend returns `cancelled`.
          await condition(() => cancelReason !== null, Math.max(r.retryAfterMs, 100));
          continue;
        case 'unknown': {
          const rec = await sender.reconcileIntent({ intentId: r.intentId });
          if (rec.status === 'accepted') return { ok: true };
          if (rec.status === 'retry_allowed') continue;
          // Hold the conversation and wait for authoritative evidence or an operator decision.
          await store.setRunStatus({ runId, status: 'blocked_unknown', reason: r.reason });
          await condition(() => resolvedIntents.has(r.intentId) || cancelReason !== null);
          if (resolvedIntents.delete(r.intentId)) {
            await store.setRunStatus({ runId, status: 'running' });
            continue; // re-enter the ledger: accepted -> move on; pending (operator: not sent) -> send
          }
          return { ok: false, outcome: 'cancelled', reason: cancelReason ?? 'run_cancelled' };
        }
        case 'cancelled':
          return { ok: false, outcome: 'cancelled', reason: r.reason };
        case 'blocked':
        case 'rejected':
          return { ok: false, outcome: 'failed', reason: r.reason };
      }
    }
  }

  /** Waits for a valid answer: evaluate inbox -> clarify / sleep until signal or deadline -> repeat. */
  async function awaitInput(step: AwaitInput, waitId: string): Promise<StepResult> {
    for (;;) {
      inboxDirty = false; // cleared *before* evaluating, so a message arriving meanwhile re-triggers
      const ev = await store.evaluateWait({ waitId });
      switch (ev.kind) {
        case 'valid':
          return { ok: true };
        case 'expired':
          return { ok: false, outcome: 'expired', reason: 'deadline_passed' };
        case 'cancelled':
          return { ok: false, outcome: 'cancelled', reason: ev.reason };
        case 'clarify': {
          const r = await send(step.id, ev.actionNo);
          if (!r.ok && r.outcome === 'cancelled') return r;
          // A clarification that could not be sent (e.g. window closed) does not end the wait.
          continue;
        }
        case 'waiting':
          // The timer uses the deadline stored in Postgres (same value the activity checks).
          await condition(() => inboxDirty || cancelReason !== null, Math.max(ev.msUntilDeadline, 0) + 100);
          continue;
      }
    }
  }

  const steps = definition.steps;
  const waits = new Map<string, string>();
  for (let idx = 0; idx < steps.length; idx++) {
    const step = steps[idx];
    if (cancelReason) return finish('cancelled', cancelReason);

    if (step.type === 'await_input') {
      const waitId = waits.get(step.id);
      if (!waitId) return finish('failed', 'wait_not_prepared');
      const r = await awaitInput(step, waitId);
      if (!r.ok) return finish(r.outcome, r.reason);
      continue;
    }

    const next = steps[idx + 1];
    const prompts = next?.type === 'await_input' && next.promptStep === step.id ? next : undefined;
    if (prompts) {
      const { waitId } = await store.prepareWait({
        runId,
        stepId: prompts.id,
        promptStepId: step.id,
        timeoutMs: parseDuration(prompts.timeout),
        maxClarifications: prompts.maxClarifications,
      });
      waits.set(prompts.id, waitId);
    }
    const r = await send(step.id, 1);
    if (!r.ok) return finish(r.outcome, r.reason);
    if (prompts) await store.activateWait({ waitId: waits.get(prompts.id)! });
  }
  return finish('completed');
}
