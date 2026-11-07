import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createTestDb } from '../helpers/db';
import { commentEvent, createAutomation, seedTenant } from '../helpers/fixtures';
import { startFakeInstagram, type FakeInstagram } from '../../src/fakes/fake-instagram';
import { HttpInstagramAdapter } from '../../src/adapters/instagram';
import { ingestEvent } from '../../src/ingest/ingest';
import { routeEvent } from '../../src/ingest/router';
import { systemClock } from '../../src/domain/clock';
import { Reason } from '../../src/domain/reasons';
import { executeSend, reconcileIntent } from '../../src/activities/send';
import { SimulatedCrash, type ActivityDeps } from '../../src/activities/deps';
import type { Capabilities } from '../../src/domain/types';

describe('send ledger and policy gate', () => {
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
    deps = { db, clock: systemClock, platform: new HttpInstagramAdapter(ig.url, { timeoutMs: 400 }) };
  });

  async function startRun(o: { capabilities?: Partial<Capabilities>; occurredAt?: string; tn?: Awaited<ReturnType<typeof seedTenant>> } = {}) {
    const tn = o.tn ?? (await seedTenant(db, { capabilities: o.capabilities }));
    if (!o.tn) await createAutomation(db, tn);
    const res = await ingestEvent({ db, clock: systemClock }, commentEvent({ accountId: tn.accountId, from: `u_${Math.random()}`, occurredAt: o.occurredAt }));
    const route = await routeEvent({ db, clock: systemClock }, (res as any).eventId);
    return { tn, runId: route.runId! };
  }
  const intent = async (id: string) => (await db.query(`SELECT * FROM message_intents WHERE id = $1`, [id])).rows[0];
  const crashOnce = (hook: 'afterProviderCall' | 'afterResultCommit') => {
    let fired = false;
    deps.hooks = {
      [hook]: () => {
        if (!fired) {
          fired = true;
          throw new SimulatedCrash(hook);
        }
      },
    };
  };

  it('re-entering an accepted send returns the stored result without sending again', async () => {
    const { runId } = await startRun();
    const first = await executeSend(deps, { runId, stepId: 'public_reply', actionNo: 1 });
    const again = await executeSend(deps, { runId, stepId: 'public_reply', actionNo: 1 });
    expect(first.status).toBe('accepted');
    expect(again).toEqual(first);
    expect(ig.sent()).toHaveLength(1);
    expect(ig.sent()[0]).toMatchObject({ kind: 'comment_reply', text: 'Sent you a DM!' });
  });

  it('a lost acknowledgement becomes unknown, is never resent, and opens one incident', async () => {
    const { runId, tn } = await startRun();
    ig.pushFault({ mode: 'accept_then_drop' });
    const first = await executeSend(deps, { runId, stepId: 'public_reply', actionNo: 1 });
    expect(first).toMatchObject({ status: 'unknown' });
    expect(await executeSend(deps, { runId, stepId: 'public_reply', actionNo: 1 })).toMatchObject({ status: 'unknown' });
    expect(ig.sent()).toHaveLength(1);
    const inc = await db.query(`SELECT error_class, status FROM incidents WHERE tenant_id = $1`, [tn.tenantId]);
    expect(inc.rows).toEqual([{ error_class: 'send_outcome_unknown', status: 'open' }]);
  });

  it('worker dies after the provider accepted but before recording: retry finds in_flight and does not resend', async () => {
    const { runId } = await startRun();
    crashOnce('afterProviderCall');
    await expect(executeSend(deps, { runId, stepId: 'public_reply', actionNo: 1 })).rejects.toBeInstanceOf(SimulatedCrash);
    const retry = await executeSend(deps, { runId, stepId: 'public_reply', actionNo: 1 });
    expect(retry).toMatchObject({ status: 'unknown', reason: Reason.ATTEMPT_OUTCOME_LOST });
    expect(ig.sent()).toHaveLength(1);
  });

  it('worker dies after recording the result: retry returns the stored acceptance', async () => {
    const { runId } = await startRun();
    crashOnce('afterResultCommit');
    await expect(executeSend(deps, { runId, stepId: 'public_reply', actionNo: 1 })).rejects.toBeInstanceOf(SimulatedCrash);
    expect(await executeSend(deps, { runId, stepId: 'public_reply', actionNo: 1 })).toMatchObject({ status: 'accepted' });
    expect(ig.sent()).toHaveLength(1);
  });

  it('provider throttling defers the same intent; the next attempt sends it once', async () => {
    const { runId } = await startRun();
    ig.pushFault({ mode: 'rate_limit' });
    const first = await executeSend(deps, { runId, stepId: 'public_reply', actionNo: 1 });
    expect(first).toMatchObject({ status: 'deferred', reason: Reason.PROVIDER_THROTTLED });
    expect((await intent(first.intentId)).status).toBe('pending');
    expect(await executeSend(deps, { runId, stepId: 'public_reply', actionNo: 1 })).toMatchObject({ status: 'accepted' });
    expect(ig.sent()).toHaveLength(1);
    expect((await intent(first.intentId)).attempt_count).toBe(2);
  });

  it('a permanent provider error is rejected and not retried', async () => {
    const { runId } = await startRun();
    ig.pushFault({ mode: 'reject_permanent' });
    expect(await executeSend(deps, { runId, stepId: 'public_reply', actionNo: 1 })).toMatchObject({ status: 'rejected' });
    expect(await executeSend(deps, { runId, stepId: 'public_reply', actionNo: 1 })).toMatchObject({ status: 'rejected' });
    expect(ig.sent()).toHaveLength(0);
  });

  it('a cancelled run cannot send', async () => {
    const { runId } = await startRun();
    await db.query(`UPDATE run_controls SET cancel_requested = true, cancel_reason = 'operator' WHERE run_id = $1`, [runId]);
    expect(await executeSend(deps, { runId, stepId: 'public_reply', actionNo: 1 })).toMatchObject({ status: 'cancelled' });
    expect(ig.sent()).toHaveLength(0);
  });

  it('a private reply outside the allowed window is blocked before any call', async () => {
    const eightDaysAgo = new Date(Date.now() - 8 * 86_400_000).toISOString();
    const { runId } = await startRun({ occurredAt: eightDaysAgo });
    expect(await executeSend(deps, { runId, stepId: 'ask_email', actionNo: 1 })).toMatchObject({ status: 'blocked', reason: Reason.WINDOW_CLOSED });
    expect(ig.sent()).toHaveLength(0);
  });

  it('a DM without a recent inbound message is blocked (messaging window)', async () => {
    const { runId } = await startRun();
    expect(await executeSend(deps, { runId, stepId: 'send_link', actionNo: 1 })).toMatchObject({ status: 'blocked', reason: Reason.WINDOW_CLOSED });
    expect(ig.sent()).toHaveLength(0);
  });

  it('the shared account budget defers sends beyond the window limit', async () => {
    const { runId: r1, tn } = await startRun({ capabilities: { sendsPerWindow: 1, budgetWindowSeconds: 3600 } });
    const { runId: r2 } = await startRun({ tn });
    expect(await executeSend(deps, { runId: r1, stepId: 'public_reply', actionNo: 1 })).toMatchObject({ status: 'accepted' });
    const second = await executeSend(deps, { runId: r2, stepId: 'public_reply', actionNo: 1 });
    expect(second).toMatchObject({ status: 'deferred', reason: Reason.RATE_LIMITED });
    expect(second.status === 'deferred' && second.retryAfterMs).toBeGreaterThan(0);
    expect(ig.sent()).toHaveLength(1);
  });

  it('an auth failure rejects the send, pauses the connection and blocks other runs', async () => {
    const { runId: r1, tn } = await startRun();
    const { runId: r2 } = await startRun({ tn });
    ig.pushFault({ mode: 'unauthorized' });
    expect(await executeSend(deps, { runId: r1, stepId: 'public_reply', actionNo: 1 })).toMatchObject({ status: 'rejected', reason: Reason.PROVIDER_UNAUTHORIZED });
    const conn = (await db.query(`SELECT status, sends_paused FROM social_connections WHERE id = $1`, [tn.connectionId])).rows[0];
    expect(conn).toEqual({ status: 'unauthorized', sends_paused: true });
    // Paused is a deferral, not a failure: in-flight conversations continue after reconnect (review finding).
    expect(await executeSend(deps, { runId: r2, stepId: 'public_reply', actionNo: 1 })).toMatchObject({ status: 'deferred', reason: Reason.SENDS_PAUSED });
    expect(ig.sent()).toHaveLength(0);
  });

  it('a late result for the fenced attempt resolves the unknown intent instead of being lost', async () => {
    const { runId } = await startRun();
    ig.pushFault({ mode: 'delay', delayMs: 300 });
    const slow = new HttpInstagramAdapter(ig.url, { timeoutMs: 2_000 });
    const inFlight = executeSend({ ...deps, platform: slow }, { runId, stepId: 'public_reply', actionNo: 1 });
    await new Promise((r) => setTimeout(r, 100));
    // A second worker (Temporal retry after a heartbeat/start-to-close timeout) sees in_flight.
    const concurrent = await executeSend(deps, { runId, stepId: 'public_reply', actionNo: 1 });
    expect(concurrent).toMatchObject({ status: 'unknown', reason: Reason.ATTEMPT_OUTCOME_LOST });
    await inFlight;
    const row = await intent(concurrent.intentId);
    expect(row).toMatchObject({ status: 'accepted', resolved_by: 'late_result' });
    expect(ig.sent()).toHaveLength(1);
  });

  it('a late result for a run that is still active wakes its workflow (review finding)', async () => {
    const { runId } = await startRun();
    ig.pushFault({ mode: 'delay', delayMs: 300 });
    const slow = new HttpInstagramAdapter(ig.url, { timeoutMs: 2_000 });
    const inFlight = executeSend({ ...deps, platform: slow }, { runId, stepId: 'public_reply', actionNo: 1 });
    await new Promise((r) => setTimeout(r, 100));
    const concurrent = await executeSend(deps, { runId, stepId: 'public_reply', actionNo: 1 });
    await inFlight;
    const signal = await db.query(
      `SELECT 1 FROM outbox WHERE kind = 'workflow.signal' AND payload->>'signal' = 'intentResolved' AND payload->'args'->0->>'intentId' = $1`,
      [concurrent.intentId],
    );
    expect(signal.rowCount).toBe(1);
  });

  it('operator said "not sent" but the late acceptance arrives: no second send (review finding)', async () => {
    const { runId } = await startRun();
    ig.pushFault({ mode: 'delay', delayMs: 300 });
    const slow = new HttpInstagramAdapter(ig.url, { timeoutMs: 2_000 });
    const inFlight = executeSend({ ...deps, platform: slow }, { runId, stepId: 'public_reply', actionNo: 1 });
    await new Promise((r) => setTimeout(r, 100));
    const concurrent = await executeSend(deps, { runId, stepId: 'public_reply', actionNo: 1 });
    await db.query(`UPDATE message_intents SET status = 'pending', current_attempt_id = NULL, resolved_by = 'operator' WHERE id = $1`, [concurrent.intentId]);
    await inFlight;
    expect(await intent(concurrent.intentId)).toMatchObject({ status: 'accepted', resolved_by: 'late_result' });
    expect(await executeSend(deps, { runId, stepId: 'public_reply', actionNo: 1 })).toMatchObject({ status: 'accepted' });
    expect(ig.sent()).toHaveLength(1);
  });

  it('an account whose adapter contract lacks a capability the send needs does not send (review finding)', async () => {
    const { runId, tn } = await startRun();
    await db.query(`UPDATE social_connections SET capabilities = '{}' WHERE id = $1`, [tn.connectionId]);
    expect(await executeSend(deps, { runId, stepId: 'public_reply', actionNo: 1 })).toMatchObject({ status: 'blocked', reason: Reason.CAPABILITY_UNKNOWN });
    expect(ig.sent()).toHaveLength(0);
  });

  it('a failing reconciliation lookup leaves the send unresolved instead of failing the run (review finding)', async () => {
    const { runId } = await startRun({ capabilities: { reconciliation: 'lookup_by_client_ref' } });
    ig.pushFault({ mode: 'accept_then_drop' });
    const r = await executeSend(deps, { runId, stepId: 'public_reply', actionNo: 1 });
    const broken = { ...deps, platform: { send: deps.platform.send.bind(deps.platform), lookupByClientRef: async () => { throw new Error('provider down'); } } };
    expect(await reconcileIntent(broken, { intentId: r.intentId })).toEqual({ status: 'unresolved' });
  });

  it('reconciliation by client reference resolves an unknown send when the adapter supports it', async () => {
    const { runId } = await startRun({ capabilities: { reconciliation: 'lookup_by_client_ref' } });
    ig.pushFault({ mode: 'accept_then_drop' });
    const r = await executeSend(deps, { runId, stepId: 'public_reply', actionNo: 1 });
    expect(r.status).toBe('unknown');
    expect(await reconcileIntent(deps, { intentId: r.intentId })).toEqual({ status: 'accepted' });
    expect(await intent(r.intentId)).toMatchObject({ status: 'accepted', resolved_by: 'reconciliation', provider_message_id: ig.sent()[0].id });
  });

  it('without reconciliation support an unknown send stays unresolved', async () => {
    const { runId } = await startRun();
    ig.pushFault({ mode: 'accept_then_drop' });
    const r = await executeSend(deps, { runId, stepId: 'public_reply', actionNo: 1 });
    expect(await reconcileIntent(deps, { intentId: r.intentId })).toEqual({ status: 'unresolved' });
  });

  it('reserving the prompt fixes the wait boundary and deadline once', async () => {
    const { runId } = await startRun();
    const run = (await db.query(`SELECT tenant_id, conversation_id FROM automation_runs WHERE id = $1`, [runId])).rows[0];
    const waitId = (
      await db.query(
        `INSERT INTO input_waits (tenant_id, run_id, step_id, prompt_step_id, conversation_id, status, timeout_ms, max_clarifications)
         VALUES ($1, $2, 'email', 'ask_email', $3, 'prepared', 60000, 1) RETURNING id`,
        [run.tenant_id, runId, run.conversation_id],
      )
    ).rows[0].id;
    ig.pushFault({ mode: 'rate_limit' });
    await executeSend(deps, { runId, stepId: 'ask_email', actionNo: 1 });
    const w1 = (await db.query(`SELECT boundary_seq, prompt_started_at, deadline FROM input_waits WHERE id = $1`, [waitId])).rows[0];
    expect(w1.boundary_seq).not.toBeNull();
    expect(w1.deadline.getTime() - w1.prompt_started_at.getTime()).toBe(60_000);
    await executeSend(deps, { runId, stepId: 'ask_email', actionNo: 1 });
    const w2 = (await db.query(`SELECT deadline FROM input_waits WHERE id = $1`, [waitId])).rows[0];
    expect(w2.deadline.getTime()).toBe(w1.deadline.getTime());
    expect(ig.sent()[0]).toMatchObject({ kind: 'private_reply' });
  });
});
