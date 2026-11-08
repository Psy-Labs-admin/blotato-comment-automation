import { ActivityFailure, condition, continueAsNew, defineSignal, patched, proxyActivities, setHandler, workflowInfo } from '@temporalio/workflow';
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
 * because every wait also re-checks Postgres periodically (`recheckMs`). Deterministic: no I/O,
 * no Date.now() decisions here.
 *
 * Guaranteed end state: whatever happens, the run is finalized (finished_at set, conversation
 * released or visibly held because a send is unknown). An activity that keeps failing ends the
 * run as `failed: activity_failed`; the finalizer itself retries until the database is back.
 */

export const inboxChanged = defineSignal('inboxChanged');
export const cancelRequested = defineSignal<[{ reason?: string }]>('cancelRequested');
export const intentResolved = defineSignal<[{ intentId: string }]>('intentResolved');

// Idempotent DB activities: generous retries (~15 min with the 30s cap), then the run fails visibly.
const store = proxyActivities<Activities>({
  startToCloseTimeout: '20s',
  retry: { initialInterval: '200ms', backoffCoefficient: 2, maximumInterval: '30s', maximumAttempts: 40 },
});

// Retrying a send activity is safe *only* because every entry re-checks the ledger first: an attempt
// whose outcome was lost becomes `unknown` and is never blindly re-sent.
const sender = proxyActivities<Pick<Activities, 'executeSend' | 'reconcileIntent'>>({
  startToCloseTimeout: '30s',
  retry: { initialInterval: '300ms', backoffCoefficient: 2, maximumInterval: '30s', maximumAttempts: 40 },
});

// The end state must always be recorded: retry until Postgres is reachable again.
const finalizer = proxyActivities<Pick<Activities, 'finalizeRun'>>({
  startToCloseTimeout: '20s',
  retry: { initialInterval: '500ms', backoffCoefficient: 2, maximumInterval: '60s' },
});

/** Total time a single send may wait for budget / pause before the run gives up visibly. */
const MAX_DEFERRAL_MS = 24 * 3_600_000;
const DEFAULT_RECHECK_MS = 10 * 60_000;

interface WorkflowResumeState {
  stepIndex: number;
  waits: Record<string, string>;
  pendingSend?: { stepId: string; actionNo: number; clarification: boolean; deferredMs: number };
  cancelReason?: string | null;
}

export interface CommentAutomationInput {
  runId: string;
  /** The pinned, immutable version this run executes (later edits never change a running run). */
  definition: AutomationDefinition;
  /** How often waits re-check Postgres without a signal. */
  recheckMs?: number;
  /** Internal test override. Normal workers roll over well before the server history limit. */
  historyRolloverThreshold?: number;
  /** Internal continue-as-new checkpoint. Business facts and deadlines remain in Postgres. */
  resume?: WorkflowResumeState;
}

type StepResult = { ok: true } | { ok: false; outcome: RunOutcome; reason: string };

export async function commentAutomation(input: CommentAutomationInput): Promise<RunOutcome> {
  const { runId, definition } = input;
  const recheckMs = input.recheckMs ?? DEFAULT_RECHECK_MS;
  // Existing histories retain their original clarification command order during replay.
  const interruptClarifications = patched('clarification-input-interrupt-v1');
  const resume: WorkflowResumeState = input.resume ?? { stepIndex: 0, waits: {} };
  let inboxDirty = false;
  let cancelReason: string | null = resume.cancelReason ?? null;
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

  async function checkpoint(): Promise<void> {
    // Keep the patch at the safe checkpoint, so pre-patch waits can adopt it when
    // replay catches up to live execution without changing earlier activity order.
    if (!patched('history-rollover-v1')) return;
    cancelReason = (await store.readRunControl({ runId })).cancelReason;
    if (workflowInfo().continueAsNewSuggested || workflowInfo().historyLength >= (input.historyRolloverThreshold ?? 8000)) {
      await continueAsNew<typeof commentAutomation>({ ...input, resume: { ...resume, cancelReason } });
    }
  }

  async function finish(outcome: RunOutcome, reason?: string): Promise<RunOutcome> {
    await finalizer.finalizeRun({ runId, outcome, reason });
    return outcome;
  }

  /** Sends one logical action through the ledger, handling deferral and uncertainty. */
  async function send(stepId: string, actionNo: number, clarification = false): Promise<StepResult> {
    const pending = resume.pendingSend?.stepId === stepId && resume.pendingSend.actionNo === actionNo
      ? resume.pendingSend : { stepId, actionNo, clarification, deferredMs: 0 };
    resume.pendingSend = pending;
    const done = (result: StepResult): StepResult => {
      resume.pendingSend = undefined;
      return result;
    };
    for (;;) {
      const r = await sender.executeSend({ runId, stepId, actionNo });
      switch (r.status) {
        case 'accepted':
          return done({ ok: true });
        case 'deferred': {
          if (pending.deferredMs >= MAX_DEFERRAL_MS) return done({ ok: false, outcome: 'failed', reason: 'deferral_budget_exhausted' });
          const sleepMs = Math.min(Math.max(r.retryAfterMs, 100), recheckMs);
          pending.deferredMs += sleepMs;
          // Durable timer; a cancel wakes us early and the next executeSend returns `cancelled`.
          await condition(() => cancelReason !== null || (clarification && interruptClarifications && inboxDirty), sleepMs);
          // A new reply can make a queued clarification obsolete. Its caller re-evaluates the
          // wait before choosing another send, and the ledger retains the original retry time.
          if (clarification && interruptClarifications && inboxDirty) return done({ ok: true });
          await checkpoint();
          continue;
        }
        case 'unknown': {
          // Hold the conversation until there is authoritative evidence (lookup, late result,
          // operator). Re-checked on every signal and every `recheckMs`, so a lost signal costs
          // minutes, not a stuck run.
          let status = (await sender.reconcileIntent({ intentId: r.intentId })).status;
          if (status === 'unresolved') await store.setRunStatus({ runId, status: 'blocked_unknown', reason: r.reason });
          while (status === 'unresolved') {
            await condition(() => resolvedIntents.has(r.intentId) || cancelReason !== null, recheckMs);
            resolvedIntents.delete(r.intentId);
            if (cancelReason) return done({ ok: false, outcome: 'cancelled', reason: cancelReason });
            status = (await sender.reconcileIntent({ intentId: r.intentId })).status;
            if (status === 'unresolved') await checkpoint();
          }
          await store.setRunStatus({ runId, status: 'running' });
          if (status === 'accepted') return done({ ok: true });
          continue; // retry_allowed (operator: not sent) -> deliberate new attempt of the same intent
        }
        case 'cancelled':
          return done({ ok: false, outcome: 'cancelled', reason: r.reason });
        case 'blocked':
          return done({ ok: false, outcome: r.reason === 'deadline_passed' ? 'expired' : 'failed', reason: r.reason });
        case 'rejected':
          return done({ ok: false, outcome: 'failed', reason: r.reason });
      }
    }
  }

  /** Waits for a valid answer: evaluate inbox -> clarify / sleep until signal, re-check or deadline. */
  async function awaitInput(step: AwaitInput, waitId: string): Promise<StepResult> {
    // An uncertain clarification must settle before consuming a queued answer. Its logical
    // send identity survives rollover, so a valid email cannot bypass an unresolved effect.
    if (resume.pendingSend?.clarification) {
      const r = await send(step.id, resume.pendingSend.actionNo, true);
      if (!r.ok && r.outcome === 'cancelled') return r;
    }
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
          const r = await send(step.id, ev.actionNo, true);
          if (!r.ok && r.outcome === 'cancelled') return r;
          // A clarification that could not be sent (window closed, deadline) does not end the wait.
          continue;
        }
        case 'waiting':
          // The timer uses the deadline stored in Postgres (same value the activity checks).
          await condition(() => inboxDirty || cancelReason !== null, Math.min(Math.max(ev.msUntilDeadline, 0) + 100, recheckMs));
          await checkpoint();
          continue;
      }
    }
  }

  async function runSteps(): Promise<RunOutcome> {
    if (input.resume) cancelReason = (await store.readRunControl({ runId })).cancelReason;
    const steps = definition.steps;
    const waits = resume.waits;
    for (let idx = resume.stepIndex; idx < steps.length; idx++) {
      resume.stepIndex = idx;
      const step = steps[idx];
      if (cancelReason) return finish('cancelled', cancelReason);

      if (step.type === 'await_input') {
        const waitId = waits[step.id];
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
        waits[prompts.id] = waitId;
      }
      const r = await send(step.id, 1);
      if (!r.ok) return finish(r.outcome, r.reason);
      if (prompts) await store.activateWait({ waitId: waits[prompts.id] });
    }
    return finish('completed');
  }

  try {
    return await runSteps();
  } catch (err) {
    // An activity exhausted its retries (or failed non-retryably): end visibly instead of leaving
    // the run "running" and the conversation held forever.
    if (err instanceof ActivityFailure) return finish('failed', 'activity_failed');
    throw err;
  }
}
