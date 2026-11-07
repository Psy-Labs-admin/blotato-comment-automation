import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createTestDb } from '../helpers/db';
import { commentEvent, createAutomation, dmEvent, seedTenant } from '../helpers/fixtures';
import { pricingWith } from '../helpers/definitions';
import { ingestEvent } from '../../src/ingest/ingest';
import { routeEvent } from '../../src/ingest/router';
import { systemClock } from '../../src/domain/clock';
import { Reason } from '../../src/domain/reasons';

describe('ingest and routing', () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: Pool;
  const deps = () => ({ db, clock: systemClock });

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
  });
  afterAll(async () => t?.drop());

  async function deliver(raw: unknown) {
    const res = await ingestEvent(deps(), raw);
    if (res.status !== 'accepted') return { res, route: undefined };
    const route = await routeEvent(deps(), res.eventId);
    return { res, route };
  }
  const count = async (sql: string, params: unknown[]) => Number((await db.query(sql, params)).rows[0].n);

  it('delivering one comment webhook five times concurrently creates one inbox row and one run', async () => {
    const tn = await seedTenant(db);
    await createAutomation(db, tn);
    const ev = commentEvent({ accountId: tn.accountId, from: 'alice' });
    const results = await Promise.all(Array.from({ length: 5 }, () => deliver(ev)));

    expect(results.filter((r) => r.res.status === 'accepted' && !r.res.duplicate)).toHaveLength(1);
    expect(await count(`SELECT count(*) n FROM inbox_events WHERE connection_id = $1`, [tn.connectionId])).toBe(1);
    expect(await count(`SELECT count(*) n FROM automation_runs WHERE tenant_id = $1`, [tn.tenantId])).toBe(1);
    expect(await count(`SELECT count(*) n FROM outbox WHERE tenant_id = $1 AND kind = 'workflow.start'`, [tn.tenantId])).toBe(1);
  });

  it('two different trigger comments from one participant: one run owns the conversation, the other is suppressed', async () => {
    const tn = await seedTenant(db);
    await createAutomation(db, tn);
    const [a, b] = await Promise.all([
      deliver(commentEvent({ accountId: tn.accountId, from: 'bob', mediaId: 'post_1' })),
      deliver(commentEvent({ accountId: tn.accountId, from: 'bob', mediaId: 'post_2' })),
    ]);
    const outcomes = [a.route!.outcome, b.route!.outcome].sort();
    expect(outcomes).toEqual([Reason.CONVERSATION_BUSY, Reason.STARTED].sort());
    expect(await count(`SELECT count(*) n FROM automation_runs WHERE tenant_id = $1`, [tn.tenantId])).toBe(1);
    expect(
      await count(`SELECT count(*) n FROM run_audit_events WHERE tenant_id = $1 AND reason = $2`, [tn.tenantId, Reason.CONVERSATION_BUSY]),
    ).toBe(1);
  });

  it('when two automations match, the higher priority wins and the loser is audited', async () => {
    const tn = await seedTenant(db);
    const low = await createAutomation(db, tn, pricingWith({}), { priority: 1, name: 'low' });
    const high = await createAutomation(db, tn, pricingWith({}), { priority: 5, name: 'high' });
    const { route } = await deliver(commentEvent({ accountId: tn.accountId, from: 'carol' }));
    const run = (await db.query(`SELECT automation_id FROM automation_runs WHERE id = $1`, [route!.runId])).rows[0];
    expect(run.automation_id).toBe(high.automationId);
    const loser = await db.query(
      `SELECT data FROM run_audit_events WHERE tenant_id = $1 AND reason = $2`,
      [tn.tenantId, Reason.LOWER_PRIORITY],
    );
    expect(loser.rows[0].data.automationId).toBe(low.automationId);
  });

  it('a new trigger within the cooldown after a finished run is suppressed', async () => {
    const tn = await seedTenant(db);
    await createAutomation(db, tn, pricingWith({}), { cooldownSeconds: 3600 });
    const first = await deliver(commentEvent({ accountId: tn.accountId, from: 'dan' }));
    await db.query(
      `UPDATE conversations SET owner_run_id = NULL, last_run_finished_at = now() WHERE id =
         (SELECT conversation_id FROM automation_runs WHERE id = $1)`,
      [first.route!.runId],
    );
    const second = await deliver(commentEvent({ accountId: tn.accountId, from: 'dan' }));
    expect(second.route!.outcome).toBe(Reason.COOLDOWN);
  });

  it('a comment written by the connected account itself never starts a run', async () => {
    const tn = await seedTenant(db);
    await createAutomation(db, tn);
    const { res } = await deliver(commentEvent({ accountId: tn.accountId, from: tn.accountId, text: 'Sent you a DM! pricing' }));
    expect(res.status).toBe('accepted');
    const ev = (await db.query(`SELECT routing_status, routing_outcome FROM inbox_events WHERE id = $1`, [(res as any).eventId])).rows[0];
    expect(ev).toEqual({ routing_status: 'routed', routing_outcome: Reason.IGNORED_SELF });
    expect(await count(`SELECT count(*) n FROM automation_runs WHERE tenant_id = $1`, [tn.tenantId])).toBe(0);
  });

  it('rejects an event for an unknown account with 404 and stores nothing', async () => {
    const res = await ingestEvent(deps(), commentEvent({ accountId: 'ig_nobody', from: 'x' }));
    expect(res).toMatchObject({ status: 'rejected', httpStatus: 404 });
    expect(await count(`SELECT count(*) n FROM inbox_events WHERE provider_event_key LIKE 'c_%' AND participant_id = 'x'`, [])).toBe(0);
  });

  it('rejects a malformed event with 400', async () => {
    expect(await ingestEvent(deps(), { type: 'comment.created', accountId: 'a' })).toMatchObject({ status: 'rejected', httpStatus: 400 });
    expect(await ingestEvent(deps(), 'not json')).toMatchObject({ status: 'rejected', httpStatus: 400 });
  });

  it('a DM from someone without an active run is stored with an explainable outcome and nothing else', async () => {
    const tn = await seedTenant(db);
    await createAutomation(db, tn);
    const { route } = await deliver(dmEvent({ accountId: tn.accountId, from: 'erin', text: 'hi there' }));
    expect(route!.outcome).toBe(Reason.NO_ACTIVE_RUN);
    expect(await count(`SELECT count(*) n FROM outbox WHERE tenant_id = $1`, [tn.tenantId])).toBe(0);
  });

  it('a comment without the keyword is recorded as no_match', async () => {
    const tn = await seedTenant(db);
    await createAutomation(db, tn);
    const { route } = await deliver(commentEvent({ accountId: tn.accountId, from: 'fay', text: 'love this pricingplan' }));
    expect(route!.outcome).toBe(Reason.NO_MATCH);
  });

  it('a disabled automation does not trigger', async () => {
    const tn = await seedTenant(db);
    const a = await createAutomation(db, tn);
    await db.query(`UPDATE automations SET status = 'disabled' WHERE id = $1`, [a.automationId]);
    const { route } = await deliver(commentEvent({ accountId: tn.accountId, from: 'gus' }));
    expect(route!.outcome).toBe(Reason.NO_MATCH);
  });

  it('respects a post filter', async () => {
    const tn = await seedTenant(db);
    const def = pricingWith({});
    (def.trigger as any).posts = { mediaIds: ['launch_post'] };
    await createAutomation(db, tn, def);
    expect((await deliver(commentEvent({ accountId: tn.accountId, from: 'h1', mediaId: 'other' }))).route!.outcome).toBe(Reason.NO_MATCH);
    expect((await deliver(commentEvent({ accountId: tn.accountId, from: 'h2', mediaId: 'launch_post' }))).route!.outcome).toBe(Reason.STARTED);
  });

  it('STOP opts the participant out and cancels their active run; later triggers are suppressed', async () => {
    const tn = await seedTenant(db);
    await createAutomation(db, tn);
    const started = await deliver(commentEvent({ accountId: tn.accountId, from: 'ivy' }));
    const stop = await deliver(dmEvent({ accountId: tn.accountId, from: 'ivy', text: 'STOP' }));
    expect(stop.route!.outcome).toBe(Reason.STOP_COMMAND);
    const ctl = (await db.query(`SELECT cancel_requested, cancel_reason FROM run_controls WHERE run_id = $1`, [started.route!.runId])).rows[0];
    expect(ctl).toEqual({ cancel_requested: true, cancel_reason: Reason.OPTED_OUT });
    expect(await count(`SELECT count(*) n FROM outbox WHERE idempotency_key = $1`, [`cancel:${started.route!.runId}`])).toBe(1);
    await db.query(`UPDATE conversations SET owner_run_id = NULL WHERE participant_id = 'ivy'`);
    expect((await deliver(commentEvent({ accountId: tn.accountId, from: 'ivy' }))).route!.outcome).toBe(Reason.OPTED_OUT);
  });

  it('two tenants with identical participant and comment ids stay isolated', async () => {
    const t1 = await seedTenant(db, { name: 'one' });
    const t2 = await seedTenant(db, { name: 'two' });
    await createAutomation(db, t1);
    await createAutomation(db, t2);
    const r1 = await deliver(commentEvent({ accountId: t1.accountId, from: 'same_user', commentId: 'same_comment' }));
    const r2 = await deliver(commentEvent({ accountId: t2.accountId, from: 'same_user', commentId: 'same_comment' }));
    expect(r1.route!.outcome).toBe(Reason.STARTED);
    expect(r2.route!.outcome).toBe(Reason.STARTED);
    const runs = await db.query(`SELECT tenant_id FROM automation_runs WHERE id = ANY($1)`, [[r1.route!.runId, r2.route!.runId]]);
    expect(new Set(runs.rows.map((r) => r.tenant_id))).toEqual(new Set([t1.tenantId, t2.tenantId]));
  });
});
