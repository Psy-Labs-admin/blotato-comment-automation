import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../helpers/harness';
import { pricingWith } from '../helpers/definitions';
import { publishVersion } from '../../src/storage/admin';

describe('races between replies, signals, timers and acknowledgements', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness({ sendTimeoutMs: 4_000 });
  });
  afterAll(async () => h?.close());

  it('reply arrives while the question is still in flight (ack delayed 1.5s): consumed once after the ack', async () => {
    h.ig.pushFault({ mode: 'delay', delayMs: 1_500, kind: 'private_reply' });
    const { runId } = await h.comment('early_bird');
    await h.waitFor(async () => (await h.wait(runId!))?.boundary_seq !== null && (await h.wait(runId!)) !== undefined, 10_000, 'prompt reserved');
    expect((await h.run(runId!)).status).not.toBe('waiting_input');
    await h.dm('early_bird', 'early@example.com');
    expect((await h.waitForRun(runId!)).status).toBe('completed');
    expect(h.messagesFor('early_bird')).toHaveLength(1);
  });

  it('two different emails at the same time: one decision, one lead, one link', async () => {
    const { runId } = await h.comment('twins');
    await h.waitForRun(runId!, 'waiting_input');
    await Promise.all([h.dm('twins', 'one@example.com'), h.dm('twins', 'two@example.com')]);
    expect((await h.waitForRun(runId!)).status).toBe('completed');
    expect(h.messagesFor('twins')).toHaveLength(1);
    expect((await h.db.query(`SELECT count(*)::int AS n FROM leads WHERE run_id = $1`, [runId])).rows[0].n).toBe(1);
  });

  it('email accepted in time but its wake-up signal is stuck: the timer path still finds it (not expired)', async () => {
    await publishVersion(h.db, { tenantId: h.tenant.tenantId, automationId: h.automation.automationId, definition: pricingWith({ timeout: '3s' }) });
    const { runId } = await h.comment('stuck_signal');
    await h.waitForRun(runId!, 'waiting_input');
    await new Promise((r) => setTimeout(r, 500)); // let the workflow park on its deadline timer
    await h.temporalRelay.stop(); // signals stay in the outbox
    await h.dm('stuck_signal', 'stuck@example.com');
    expect((await h.waitForRun(runId!, undefined, 15_000)).status).toBe('completed');
    expect(h.messagesFor('stuck_signal')).toHaveLength(1);
    // Proof that the timer path (not a signal) consumed it: the lead was created after the deadline.
    const [lead, wait] = [await h.lead(runId!), await h.wait(runId!)];
    expect(lead.created_at.getTime()).toBeGreaterThanOrEqual(wait.deadline.getTime());
    h.temporalRelay.start(); // the late signal reaches a finished run and is dropped harmlessly
    await h.waitFor(
      async () => (await h.db.query(`SELECT count(*)::int AS n FROM outbox WHERE status = 'pending' AND kind = 'workflow.signal'`)).rows[0].n === 0,
      10_000,
      'stale signal drained',
    );
    await publishVersion(h.db, { tenantId: h.tenant.tenantId, automationId: h.automation.automationId, definition: pricingWith({ timeout: '30s' }) });
  });

  it('an email that arrives exactly as the deadline passes is either consumed or the run expires — never both', async () => {
    await publishVersion(h.db, { tenantId: h.tenant.tenantId, automationId: h.automation.automationId, definition: pricingWith({ timeout: '2s' }) });
    const { runId } = await h.comment('photo_finish');
    const w = await h.waitFor(async () => (await h.wait(runId!))?.deadline ?? undefined, 10_000, 'deadline');
    const msLeft = new Date(w).getTime() - Date.now();
    await new Promise((r) => setTimeout(r, Math.max(0, msLeft - 5)));
    await h.dm('photo_finish', 'finish@example.com');
    const run = await h.waitForRun(runId!, undefined, 15_000);
    const lead = await h.lead(runId!);
    if (run.status === 'completed') {
      expect(lead).toBeDefined();
      expect(h.messagesFor('photo_finish')).toHaveLength(1);
    } else {
      expect(run.status).toBe('expired');
      expect(lead).toBeUndefined();
      expect(h.messagesFor('photo_finish')).toHaveLength(0);
    }
    await publishVersion(h.db, { tenantId: h.tenant.tenantId, automationId: h.automation.automationId, definition: pricingWith({ timeout: '30s' }) });
  });
});
