import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../helpers/harness';

describe('cancel, opt-out and human takeover', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(async () => h?.close());

  it('cancel during the wait: no further sends, conversation released', async () => {
    const { runId } = await h.comment('cancel_user');
    await h.waitForRun(runId!, 'waiting_input');
    expect((await h.request('POST', `/runs/${runId}/cancel`, { reason: 'operator' })).status).toBe(202);
    expect(await h.waitForRun(runId!)).toMatchObject({ status: 'cancelled', status_reason: 'operator' });
    await h.dm('cancel_user', 'cancel@example.com');
    await new Promise((r) => setTimeout(r, 300));
    expect(h.messagesFor('cancel_user')).toHaveLength(0);
    expect((await h.conversationOf(runId!)).owner_run_id).toBeNull();
  });

  it('cancel while the link send is unknown: run ends, conversation stays held until the send is resolved', async () => {
    h.ig.pushFault({ mode: 'accept_then_drop', kind: 'dm' });
    const { runId } = await h.comment('held_user');
    await h.waitForRun(runId!, 'waiting_input');
    await h.dm('held_user', 'held@example.com');
    await h.waitForRun(runId!, 'blocked_unknown');
    await h.request('POST', `/runs/${runId}/cancel`, { reason: 'operator' });
    expect((await h.waitForRun(runId!)).status).toBe('cancelled');
    expect((await h.conversationOf(runId!)).owner_run_id).toBe(runId);

    const intent = (await h.intents(runId!)).find((i) => i.status === 'unknown')!;
    expect((await h.request('POST', `/intents/${intent.id}/resolve`, { resolution: 'accepted', note: 'confirmed in inbox' })).status).toBe(200);
    expect((await h.conversationOf(runId!)).owner_run_id).toBeNull();
    expect(h.messagesFor('held_user')).toHaveLength(1);
  });

  it.each(['STOP', 'STOP!! 🙏'])('%s during the wait cancels the run and suppresses future triggers', async (command) => {
    const participant = command === 'STOP' ? 'stop_user' : 'stop_punctuation_user';
    const { runId } = await h.comment(participant);
    await h.waitForRun(runId!, 'waiting_input');
    expect((await h.dm(participant, command)).outcome).toBe('stop_command');
    expect(await h.waitForRun(runId!)).toMatchObject({ status: 'cancelled', status_reason: 'opted_out' });
    expect(await h.wait(runId!)).toMatchObject({ status: 'cancelled' });
    expect(await h.conversationOf(runId!)).toMatchObject({ opted_out: true, owner_run_id: null });
    expect(await h.lead(runId!)).toBeUndefined();
    expect(h.messagesFor(participant)).toHaveLength(0);
    expect((await h.comment(participant)).outcome).toBe('opted_out');
    expect((await h.db.query(`SELECT id FROM automation_runs WHERE conversation_id=$1`,
      [(await h.conversationOf(runId!)).id])).rows).toEqual([{ id: runId }]);
  });

  it('embedded stop text is an email reply, not an opt-out command', async () => {
    const participant = 'embedded_stop_user';
    const { runId } = await h.comment(participant);
    await h.waitForRun(runId!, 'waiting_input');
    expect((await h.dm(participant, 'Please do not stop; contact stop@example.com')).outcome).toBe('input_pending');
    expect(await h.waitForRun(runId!)).toMatchObject({ status: 'completed' });
    expect(await h.lead(runId!)).toMatchObject({ email: 'stop@example.com' });
    expect(await h.conversationOf(runId!)).toMatchObject({ opted_out: false, owner_run_id: null });
    expect(h.messagesFor(participant)).toHaveLength(1);
  });

  it('human takeover during the wait hands the conversation to a person', async () => {
    const { runId } = await h.comment('human_user');
    await h.waitForRun(runId!, 'waiting_input');
    const conv = await h.conversationOf(runId!);
    expect((await h.request('POST', `/conversations/${conv.id}/takeover`)).status).toBe(200);
    expect(await h.waitForRun(runId!)).toMatchObject({ status: 'cancelled', status_reason: 'human_takeover' });
    await h.dm('human_user', 'human@example.com');
    await new Promise((r) => setTimeout(r, 300));
    expect(h.messagesFor('human_user')).toHaveLength(0);
  });
});
