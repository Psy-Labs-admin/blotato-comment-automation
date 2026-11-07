import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../helpers/harness';
import { SimulatedCrash } from '../../src/activities/deps';

/**
 * The hardest boundary in the system: Instagram and our database share no transaction.
 * These tests make the gap happen for real (fake server stores the DM and drops the connection,
 * or the worker "dies" right after the HTTP call) and check that nothing is sent twice and that the
 * uncertainty is visible and resolvable.
 */
describe('worker crashes and uncertain sends', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(async () => h?.close());
  beforeEach(async () => {
    delete h.hooks.afterProviderCall;
    delete h.hooks.afterResultCommit;
    await h.db.query(`UPDATE social_connections SET capabilities = capabilities || '{"reconciliation":"none"}'`);
  });

  const crashOnceAt = (hook: 'afterProviderCall' | 'afterResultCommit', stepId: string) => {
    let fired = false;
    h.hooks[hook] = (_intentId, ctx) => {
      if (!fired && ctx.stepId === stepId) {
        fired = true;
        throw new SimulatedCrash(`${hook}@${stepId}`);
      }
    };
  };
  const reachLinkStep = async (who: string) => {
    const { runId } = await h.comment(who);
    await h.waitForRun(runId!, 'waiting_input');
    await h.dm(who, `${who}@example.com`);
    return runId!;
  };

  it('Instagram accepted the link DM, worker died before recording: retry does not resend; lookup reconciles', async () => {
    await h.db.query(`UPDATE social_connections SET capabilities = capabilities || '{"reconciliation":"lookup_by_client_ref"}'`);
    crashOnceAt('afterProviderCall', 'send_link');
    const runId = await reachLinkStep('crash1');
    expect((await h.waitForRun(runId)).status).toBe('completed');
    expect(h.messagesFor('crash1')).toHaveLength(1);
    const link = (await h.intents(runId)).find((i) => i.step_id === 'send_link');
    expect(link).toMatchObject({ status: 'accepted', resolved_by: 'reconciliation', attempt_count: 1 });
    // Nothing left to act on: the incident closes itself once no send of the account is unknown.
    const open = await h.db.query(`SELECT 1 FROM incidents WHERE status = 'open' AND error_class = 'send_outcome_unknown'`);
    expect(open.rowCount).toBe(0);
  });

  it('lost acknowledgement without reconciliation support: run blocks, conversation held, operator resolves, no resend', async () => {
    h.ig.pushFault({ mode: 'accept_then_drop', kind: 'dm' });
    const runId = await reachLinkStep('lost_ack');
    await h.waitForRun(runId, 'blocked_unknown');
    expect((await h.conversationOf(runId)).owner_run_id).toBe(runId);

    // A new trigger from the same person is suppressed while we don't know what they received.
    expect((await h.comment('lost_ack')).outcome).toBe('conversation_busy');

    const alert = await h.waitFor(async () => h.alerts.received().find((t) => t.includes('unknown outcome')), 10_000, 'incident alert');
    expect(alert).not.toContain('lost_ack@example.com');

    const intent = (await h.intents(runId)).find((i) => i.step_id === 'send_link')!;
    const res = await h.request('POST', `/intents/${intent.id}/resolve`, { resolution: 'accepted', note: 'Seen in the Instagram inbox' });
    expect(res.status).toBe(200);
    expect((await h.waitForRun(runId)).status).toBe('completed');
    expect(h.messagesFor('lost_ack')).toHaveLength(1);
    expect((await h.conversationOf(runId)).owner_run_id).toBeNull();
    const timeline = await h.request('GET', `/runs/${runId}/timeline`);
    expect(timeline.body.entries.map((e: any) => e.text).join('\n')).toMatch(/UNKNOWN[\s\S]*resolved as accepted \(operator\)/);
  });

  it('operator confirms "not sent": the same intent is attempted again, deliberately', async () => {
    h.ig.pushFault({ mode: 'accept_then_drop', kind: 'dm' });
    const runId = await reachLinkStep('not_sent');
    await h.waitForRun(runId, 'blocked_unknown');
    const intent = (await h.intents(runId)).find((i) => i.step_id === 'send_link')!;
    await h.request('POST', `/intents/${intent.id}/resolve`, { resolution: 'not_sent', note: 'Not visible in the inbox' });
    expect((await h.waitForRun(runId)).status).toBe('completed');
    const after = (await h.intents(runId)).find((i) => i.step_id === 'send_link')!;
    expect(after).toMatchObject({ status: 'accepted', attempt_count: 2 });
  });

  it('worker died after recording the result: the retry returns the stored acceptance', async () => {
    crashOnceAt('afterResultCommit', 'ask_email');
    const { runId } = await h.comment('crash2');
    await h.waitForRun(runId!, 'waiting_input');
    await h.dm('crash2', 'crash2@example.com');
    expect((await h.waitForRun(runId!)).status).toBe('completed');
    const kinds = h.ig.sent().filter((m) => m.recipientId === 'crash2' || m.text === 'What email should we send the pricing to?').map((m) => m.kind);
    expect(kinds.filter((k) => k === 'private_reply').length).toBeGreaterThanOrEqual(1);
    for (const i of await h.intents(runId!)) expect(i.attempt_count).toBe(1);
  });

  it('several uncertain sends on one account are grouped into one incident', async () => {
    const before = h.alerts.received().length;
    await h.db.query(`UPDATE incidents SET status = 'resolved' WHERE status = 'open'`);
    h.ig.pushFault({ mode: 'accept_then_drop', kind: 'dm' });
    h.ig.pushFault({ mode: 'accept_then_drop', kind: 'dm' });
    const a = await reachLinkStep('group_a');
    const b = await reachLinkStep('group_b');
    await h.waitForRun(a, 'blocked_unknown');
    await h.waitForRun(b, 'blocked_unknown');
    const inc = (await h.db.query(`SELECT occurrences, affected_runs FROM incidents WHERE status = 'open' AND error_class = 'send_outcome_unknown'`)).rows;
    expect(inc).toHaveLength(1);
    expect(inc[0].affected_runs).toHaveLength(2);
    await h.waitFor(async () => h.alerts.received().length > before, 10_000, 'alert');
    await new Promise((r) => setTimeout(r, 500));
    expect(h.alerts.received().length - before).toBe(1);
  });
});
