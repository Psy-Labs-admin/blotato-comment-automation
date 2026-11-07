import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ApplicationFailure } from '@temporalio/common';
import { createHarness, type Harness } from '../helpers/harness';
import { reconcileOrphans } from '../../src/relay/orphans';
import { systemClock } from '../../src/domain/clock';

/**
 * "Never hang without a visible result" (spec §8): every way a run can lose its driver must end
 * in a finished run, a released (or visibly held) conversation and, where relevant, an incident.
 */
describe('runs never get stuck silently', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(async () => h?.close());
  beforeEach(() => {
    delete h.hooks.afterProviderCall;
  });

  it('an activity that fails for good finalizes the run; the lost send becomes a visible unknown', async () => {
    let fired = false;
    h.hooks.afterProviderCall = (_id, ctx) => {
      if (!fired && ctx.stepId === 'public_reply') {
        fired = true;
        throw ApplicationFailure.nonRetryable('worker lost its database for good', 'FatalTestError');
      }
    };
    const { runId } = await h.comment('fatal_user');
    expect(await h.waitForRun(runId!, undefined, 15_000)).toMatchObject({ status: 'failed', status_reason: 'activity_failed' });
    const intent = (await h.intents(runId!)).find((i) => i.step_id === 'public_reply');
    expect(intent.status).toBe('unknown');
    const inc = await h.db.query(`SELECT 1 FROM incidents WHERE status = 'open' AND error_class = 'send_outcome_unknown'`);
    expect(inc.rowCount).toBe(1);
  });

  it('a blocked run notices evidence that arrived without a signal (periodic re-check)', async () => {
    h.ig.pushFault({ mode: 'accept_then_drop', kind: 'dm' });
    const { runId } = await h.comment('recheck_user');
    await h.waitForRun(runId!, 'waiting_input');
    await h.dm('recheck_user', 'recheck@example.com');
    await h.waitForRun(runId!, 'blocked_unknown');
    const intent = (await h.intents(runId!)).find((i) => i.status === 'unknown')!;
    // Evidence lands in the ledger with no wake-up signal (e.g. a late result whose signal was lost).
    await h.db.query(`UPDATE message_intents SET status = 'accepted', resolved_by = 'late_result' WHERE id = $1`, [intent.id]);
    expect((await h.waitForRun(runId!, undefined, 10_000)).status).toBe('completed');
    expect(h.messagesFor('recheck_user')).toHaveLength(1);
  });

  it('a workflow that disappeared (terminated, history limit) is finalized by the orphan reconciler', async () => {
    const { runId } = await h.comment('orphan_user');
    await h.waitForRun(runId!, 'waiting_input');
    const run = await h.run(runId!);
    await h.client.workflow.getHandle(run.workflow_id).terminate('simulating a lost workflow');
    expect(await reconcileOrphans({ db: h.db, client: h.client, clock: systemClock, olderThanMs: 0 })).toBe(1);
    expect(await h.run(runId!)).toMatchObject({ status: 'failed', status_reason: 'workflow_closed' });
    expect((await h.conversationOf(runId!)).owner_run_id).toBeNull();
  });

  it('pausing the account mid-conversation defers sends; resuming continues the same conversation', async () => {
    const { runId } = await h.comment('pause_user');
    await h.waitForRun(runId!, 'waiting_input');
    expect((await h.request('POST', `/connections/${h.tenant.connectionId}/pause`, { reason: 'fixing copy' })).status).toBe(200);
    await h.dm('pause_user', 'pause@example.com');
    await new Promise((r) => setTimeout(r, 1_500));
    expect(h.messagesFor('pause_user')).toHaveLength(0);
    expect((await h.run(runId!)).finished_at).toBeNull();
    expect((await h.request('POST', `/connections/${h.tenant.connectionId}/resume`)).status).toBe(200);
    expect((await h.waitForRun(runId!, undefined, 10_000)).status).toBe('completed');
    expect(h.messagesFor('pause_user')).toHaveLength(1);
  });
});
