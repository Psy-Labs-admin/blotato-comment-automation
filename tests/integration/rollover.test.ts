import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { Worker } from '@temporalio/worker';
import { createHarness, type Harness } from '../helpers/harness';
import type { commentAutomation, CommentAutomationInput } from '../../src/workflows/commentAutomation';

describe('durable workflow history rollover', () => {
  let h: Harness;
  beforeAll(async () => { h = await createHarness(); });
  afterAll(async () => h?.close());

  async function start(user: string, paused = false) {
    await h.temporalRelay.stop();
    const { runId } = await h.comment(user);
    const run = await h.run(runId!);
    const definition = (await h.db.query(`SELECT definition FROM automation_versions WHERE id = $1`, [run.version_id])).rows[0].definition;
    if (paused) await h.request('POST', `/connections/${h.tenant.connectionId}/pause`, { reason: 'rollover test' });
    const handle = await h.client.workflow.start<typeof commentAutomation>('commentAutomation', {
      taskQueue: h.taskQueue, workflowId: run.workflow_id,
      args: [{ runId: runId!, definition, recheckMs: 50, historyRolloverThreshold: 20 }],
    });
    h.temporalRelay.start();
    return { runId: runId!, workflowId: run.workflow_id, firstRunId: handle.firstExecutionRunId };
  }
  const currentRun = async (workflowId: string) => (await h.client.workflow.getHandle(workflowId).describe()).runId;
  const resumedInput = async (workflowId: string): Promise<CommentAutomationInput> => {
    const history = await h.client.workflow.getHandle(workflowId).fetchHistory();
    const payload = history.events?.find((event) => event.workflowExecutionStartedEventAttributes)?.workflowExecutionStartedEventAttributes?.input?.payloads?.[0];
    return JSON.parse(Buffer.from(payload!.data!).toString());
  };

  it('preserves the logical run, wait identity and original deadline across history runs', async () => {
    const run = await start('long_wait');
    await h.waitForRun(run.runId, 'waiting_input');
    const initialWait = await h.wait(run.runId);
    await h.waitFor(async () => await currentRun(run.workflowId) !== run.firstRunId, 10_000, 'history rollover');
    expect(await h.wait(run.runId)).toMatchObject({ id: initialWait.id, deadline: initialWait.deadline, boundary_seq: initialWait.boundary_seq });
    await h.dm('long_wait', 'rollover@example.com');
    expect((await h.waitForRun(run.runId)).status).toBe('completed');
    expect(h.messagesFor('long_wait').filter((m) => m.text.includes('https://example.com/pricing'))).toHaveLength(1);
    expect((await h.db.query(`SELECT count(*)::int AS n FROM automation_runs WHERE id = $1`, [run.runId])).rows[0].n).toBe(1);
    for (const handle of [h.client.workflow.getHandle(run.workflowId, run.firstRunId), h.client.workflow.getHandle(run.workflowId)]) {
      await Worker.runReplayHistory({ workflowsPath: path.resolve(__dirname, '../../src/workflows/index.ts') }, await handle.fetchHistory());
    }
  });

  it('keeps an unknown clarification pending across rollover even when a valid email has arrived', async () => {
    h.ig.pushFault({ mode: 'accept_then_drop', kind: 'dm', textIncludes: "doesn't look" });
    const run = await start('unknown_clarification');
    await h.waitForRun(run.runId, 'waiting_input');
    await h.dm('unknown_clarification', 'invalid reply');
    await h.waitForRun(run.runId, 'blocked_unknown');
    const before = await currentRun(run.workflowId);
    await h.dm('unknown_clarification', 'safe@example.com');
    await h.waitFor(async () => await currentRun(run.workflowId) !== before, 10_000, 'unknown clarification rollover');
    expect((await h.run(run.runId)).finished_at).toBeNull();
    expect(await h.lead(run.runId)).toBeUndefined();
    expect(h.messagesFor('unknown_clarification').filter((m) => m.text.includes('https://example.com/pricing'))).toHaveLength(0);
    const intent = (await h.intents(run.runId)).find((i) => i.status === 'unknown');
    expect((await h.request('POST', `/intents/${intent.id}/resolve`, { resolution: 'accepted', note: 'synthetic confirmation' })).status).toBe(200);
    expect((await h.waitForRun(run.runId)).status).toBe('completed');
    expect(h.messagesFor('unknown_clarification').filter((m) => m.text.includes('https://example.com/pricing'))).toHaveLength(1);
  });

  it('carries the send deferral budget and recovers cancellation from Postgres without a signal', async () => {
    const run = await start('deferred_send', true);
    await h.waitFor(async () => (await resumedInput(run.workflowId)).resume?.pendingSend?.deferredMs, 10_000, 'deferred send rollover');
    const first = (await resumedInput(run.workflowId)).resume!.pendingSend!.deferredMs;
    await h.waitFor(async () => ((await resumedInput(run.workflowId)).resume?.pendingSend?.deferredMs ?? 0) > first, 10_000, 'deferral budget carried forward');
    await h.temporalRelay.stop();
    await h.db.query(`UPDATE run_controls SET cancel_requested = true, cancel_reason = 'persisted_without_signal' WHERE run_id = $1`, [run.runId]);
    expect(await h.waitForRun(run.runId)).toMatchObject({ status: 'cancelled', status_reason: 'persisted_without_signal' });
    expect(h.messagesFor('deferred_send')).toHaveLength(0);
    await h.request('POST', `/connections/${h.tenant.connectionId}/resume`);
    h.temporalRelay.start();
  });
});
