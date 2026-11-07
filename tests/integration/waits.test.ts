import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createTestDb } from '../helpers/db';
import { commentEvent, createAutomation, dmEvent, seedTenant } from '../helpers/fixtures';
import { pricingWith } from '../helpers/definitions';
import { startFakeInstagram, type FakeInstagram } from '../../src/fakes/fake-instagram';
import { HttpInstagramAdapter } from '../../src/adapters/instagram';
import { ingestEvent } from '../../src/ingest/ingest';
import { routeEvent } from '../../src/ingest/router';
import { systemClock } from '../../src/domain/clock';
import { Reason } from '../../src/domain/reasons';
import { executeSend } from '../../src/activities/send';
import { activateWait, evaluateWait, prepareWait } from '../../src/activities/waits';
import { finalizeRun } from '../../src/activities/runs';
import type { ActivityDeps } from '../../src/activities/deps';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('waits, input consumption and leads', () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: Pool;
  let ig: FakeInstagram;
  let deps: ActivityDeps;

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    ig = await startFakeInstagram();
  });
  afterAll(async () => {
    await ig.close();
    await t?.drop();
  });
  beforeEach(() => {
    ig.reset();
    deps = { db, clock: systemClock, platform: new HttpInstagramAdapter(ig.url, { timeoutMs: 2_000 }) };
  });

  /** A run that has done its public reply and prepared (not yet sent) the email question. */
  async function runAtPrompt(o: { timeout?: string; maxClarifications?: number } = {}) {
    const tn = await seedTenant(db);
    await createAutomation(db, tn, pricingWith({ timeout: o.timeout ?? '1h', maxClarifications: o.maxClarifications ?? 1 }));
    const participant = `p_${Math.random().toString(36).slice(2, 8)}`;
    const ing = await ingestEvent({ db, clock: systemClock }, commentEvent({ accountId: tn.accountId, from: participant }));
    const { runId } = await routeEvent({ db, clock: systemClock }, (ing as any).eventId);
    await executeSend(deps, { runId: runId!, stepId: 'public_reply', actionNo: 1 });
    const timeoutMs = o.timeout === '1s' ? 1_000 : 3_600_000;
    const { waitId } = await prepareWait(deps, {
      runId: runId!, stepId: 'email', promptStepId: 'ask_email', timeoutMs, maxClarifications: o.maxClarifications ?? 1,
    });
    const dm = async (text: string) => {
      const r = await ingestEvent({ db, clock: systemClock }, dmEvent({ accountId: tn.accountId, from: participant, text }));
      return routeEvent({ db, clock: systemClock }, (r as any).eventId);
    };
    const ask = () => executeSend(deps, { runId: runId!, stepId: 'ask_email', actionNo: 1 });
    return { tn, runId: runId!, waitId, dm, ask };
  }
  const evaluate = (waitId: string) => evaluateWait(deps, { waitId });

  it('an email that arrives while the question send is still in flight is kept and consumed once after acceptance', async () => {
    const r = await runAtPrompt();
    ig.pushFault({ mode: 'delay', delayMs: 400, kind: 'private_reply' });
    const sending = r.ask();
    await sleep(100);
    const routed = await r.dm('it is jane@example.com');
    expect(routed.outcome).toBe(Reason.INPUT_PENDING);
    expect((await sending).status).toBe('accepted');
    await activateWait(deps, { waitId: r.waitId });
    const first = await evaluate(r.waitId);
    expect(first.kind).toBe('valid');
    expect(await evaluate(r.waitId)).toEqual(first);
    const lead = (await db.query(`SELECT email, email_status FROM leads WHERE run_id = $1`, [r.runId])).rows[0];
    expect(lead).toEqual({ email: 'jane@example.com', email_status: 'format_valid_unverified' });
    expect(Number((await db.query(`SELECT count(*) n FROM outbox WHERE kind = 'crm.lead_captured' AND tenant_id = $1`, [r.tn.tenantId])).rows[0].n)).toBe(1);
  });

  it('a DM sent before the question was reserved cannot answer it', async () => {
    const r = await runAtPrompt();
    expect((await r.dm('old@example.com')).outcome).toBe(Reason.BEFORE_PROMPT);
    await r.ask();
    await activateWait(deps, { waitId: r.waitId });
    expect((await evaluate(r.waitId)).kind).toBe('waiting');
    expect(Number((await db.query(`SELECT count(*) n FROM input_consumptions WHERE wait_id = $1`, [r.waitId])).rows[0].n)).toBe(0);
  });

  it('two valid emails evaluated concurrently produce one decision and one lead', async () => {
    const r = await runAtPrompt();
    await r.ask();
    await activateWait(deps, { waitId: r.waitId });
    await Promise.all([r.dm('first@example.com'), r.dm('second@example.com')]);
    const [a, b] = await Promise.all([evaluate(r.waitId), evaluate(r.waitId)]);
    expect(a).toEqual(b);
    expect(a.kind).toBe('valid');
    expect(Number((await db.query(`SELECT count(*) n FROM leads WHERE run_id = $1`, [r.runId])).rows[0].n)).toBe(1);
    const lead = (await db.query(`SELECT email FROM leads WHERE run_id = $1`, [r.runId])).rows[0];
    // Whichever message won the conversation lock first (lower seq) is the answer; never both.
    expect(['first@example.com', 'second@example.com']).toContain(lead.email);
  });

  it('an invalid answer earns exactly one clarification; repeated evaluation returns the same one', async () => {
    const r = await runAtPrompt({ maxClarifications: 1 });
    await r.ask();
    await activateWait(deps, { waitId: r.waitId });
    await r.dm('what do you need it for?');
    const c1 = await evaluate(r.waitId);
    expect(c1).toEqual({ kind: 'clarify', actionNo: 2 });
    expect(await evaluate(r.waitId)).toEqual(c1);
    // Clarification goes out (the participant has just messaged us, so the DM window is open).
    expect((await executeSend(deps, { runId: r.runId, stepId: 'email', actionNo: 2 })).status).toBe('accepted');
    await r.dm('nope');
    expect((await evaluate(r.waitId)).kind).toBe('waiting');
    await r.dm('fine: bob@example.com');
    expect((await evaluate(r.waitId)).kind).toBe('valid');
    expect(ig.sent().filter((m) => m.kind === 'dm')).toHaveLength(1);
  });

  it('two different addresses in one message are not guessed', async () => {
    const r = await runAtPrompt({ maxClarifications: 0 });
    await r.ask();
    await activateWait(deps, { waitId: r.waitId });
    await r.dm('a@x.io or b@y.io');
    expect((await evaluate(r.waitId)).kind).toBe('waiting');
    const c = (await db.query(`SELECT result FROM input_consumptions WHERE wait_id = $1`, [r.waitId])).rows[0];
    expect(c.result).toBe('ambiguous');
  });

  it('an email accepted before the deadline wins even if evaluation happens after it (delayed signal)', async () => {
    const r = await runAtPrompt({ timeout: '1s' });
    await r.ask();
    await activateWait(deps, { waitId: r.waitId });
    await r.dm('late.signal@example.com');
    await sleep(1_100);
    expect((await evaluate(r.waitId)).kind).toBe('valid');
  });

  it('no answer by the deadline expires the wait; a later email is not consumed', async () => {
    const r = await runAtPrompt({ timeout: '1s' });
    await r.ask();
    await activateWait(deps, { waitId: r.waitId });
    const w = await evaluate(r.waitId);
    expect(w.kind).toBe('waiting');
    await sleep(1_100);
    expect(await evaluate(r.waitId)).toEqual({ kind: 'expired' });
    expect((await r.dm('too.late@example.com')).outcome).toBe(Reason.NO_ACTIVE_WAIT);
    expect(await evaluate(r.waitId)).toEqual({ kind: 'expired' });
    expect(Number((await db.query(`SELECT count(*) n FROM leads WHERE run_id = $1`, [r.runId])).rows[0].n)).toBe(0);
  });

  it('a cancel request closes the wait', async () => {
    const r = await runAtPrompt();
    await r.ask();
    await activateWait(deps, { waitId: r.waitId });
    await db.query(`UPDATE run_controls SET cancel_requested = true, cancel_reason = 'operator' WHERE run_id = $1`, [r.runId]);
    expect(await evaluate(r.waitId)).toEqual({ kind: 'cancelled', reason: 'operator' });
  });

  it('a valid email already in the backlog wins over an earlier invalid message: no clarification (review finding)', async () => {
    const r = await runAtPrompt({ maxClarifications: 1 });
    await r.ask();
    await activateWait(deps, { waitId: r.waitId });
    await r.dm('hello?');
    await r.dm('ok: backlog@example.com');
    expect((await evaluate(r.waitId)).kind).toBe('valid');
    const clar = await db.query(`SELECT 1 FROM message_intents WHERE run_id = $1 AND step_id = 'email'`, [r.runId]);
    expect(clar.rowCount).toBe(0);
  });

  it('no clarification and no question go out after the deadline (review finding)', async () => {
    const r = await runAtPrompt({ timeout: '1s', maxClarifications: 1 });
    await r.ask();
    await activateWait(deps, { waitId: r.waitId });
    await r.dm('nope');
    expect(await evaluate(r.waitId)).toEqual({ kind: 'clarify', actionNo: 2 });
    await sleep(1_100);
    expect(await evaluate(r.waitId)).toEqual({ kind: 'expired' });
    expect(await executeSend(deps, { runId: r.runId, stepId: 'email', actionNo: 2 })).toMatchObject({ status: 'blocked', reason: Reason.DEADLINE_PASSED });
    expect(ig.sent().filter((m) => m.kind === 'dm')).toHaveLength(0);
  });

  it('a late acceptance for a finished run releases the conversation it was holding (review finding)', async () => {
    const r = await runAtPrompt();
    ig.pushFault({ mode: 'delay', delayMs: 400, kind: 'private_reply' });
    const slow = executeSend({ ...deps, platform: new HttpInstagramAdapter(ig.url, { timeoutMs: 3_000 }) }, { runId: r.runId, stepId: 'ask_email', actionNo: 1 });
    await sleep(100);
    expect((await r.ask()).status).toBe('unknown');
    expect(await finalizeRun(deps, { runId: r.runId, outcome: 'cancelled', reason: 'operator' })).toEqual({ conversationReleased: false });
    await slow;
    const conv = (await db.query(`SELECT owner_run_id FROM conversations c JOIN automation_runs ar ON ar.conversation_id = c.id WHERE ar.id = $1`, [r.runId])).rows[0];
    expect(conv.owner_run_id).toBeNull();
  });

  it('finalizing a run keeps the conversation held while any send outcome is unknown', async () => {
    const held = await runAtPrompt();
    ig.pushFault({ mode: 'accept_then_drop', kind: 'private_reply' });
    expect((await held.ask()).status).toBe('unknown');
    expect(await finalizeRun(deps, { runId: held.runId, outcome: 'cancelled', reason: 'operator' })).toEqual({ conversationReleased: false });
    const conv = (await db.query(`SELECT owner_run_id FROM conversations c JOIN automation_runs r ON r.conversation_id = c.id WHERE r.id = $1`, [held.runId])).rows[0];
    expect(conv.owner_run_id).toBe(held.runId);

    const clean = await runAtPrompt();
    expect(await finalizeRun(deps, { runId: clean.runId, outcome: 'completed' })).toEqual({ conversationReleased: true });
    expect(await finalizeRun(deps, { runId: clean.runId, outcome: 'completed' })).toEqual({ conversationReleased: true });
  });
});
