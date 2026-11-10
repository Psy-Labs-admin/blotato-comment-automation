import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createTestDb } from '../helpers/db';
import { commentEvent, createAutomation, dmEvent, seedTenant } from '../helpers/fixtures';
import { pricingWith } from '../helpers/definitions';
import { ingestEvent } from '../../src/ingest/ingest';
import { routeEvent, routePending } from '../../src/ingest/router';
import { finalizeRun } from '../../src/activities/runs';
import { systemClock } from '../../src/domain/clock';
import { Reason } from '../../src/domain/reasons';
import { buildTimeline } from '../../src/timeline';
import { createConnection } from '../helpers/account';

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

  it('uses provider DM time without reopening the window for delayed or reordered deliveries', async () => {
    const tn = await seedTenant(db);
    const now = new Date('2026-11-08T12:00:00Z');
    const ingest = async (occurredAt: string) => ingestEvent({ db, clock: { now: () => now } }, {
      ...dmEvent({ accountId: tn.accountId, from: 'delayed', text: 'hello' }), occurredAt,
    });
    const lastDm = async () => (await db.query(
      `SELECT last_inbound_dm_at FROM conversations WHERE connection_id = $1 AND participant_id = 'delayed'`,
      [tn.connectionId],
    )).rows[0].last_inbound_dm_at;
    await ingest('2026-11-06T12:00:00Z');
    expect(await lastDm()).toEqual(new Date('2026-11-06T12:00:00Z'));
    await ingest('2026-11-08T11:00:00Z');
    await ingest('2026-11-07T12:00:00Z');
    expect(await lastDm()).toEqual(new Date('2026-11-08T11:00:00Z'));
    await ingest('2026-11-09T12:00:00Z');
    expect(await lastDm()).toEqual(now);
  });

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

  function typoDefinition(keyword = 'pricing') {
    const def = pricingWith({ keyword });
    def.trigger.match = 'whole_word_with_typos';
    return def;
  }

  it('typo matching requires opt-in; opted-in routing is deduplicated and explained in the timeline', async () => {
    const tn = await seedTenant(db);
    const rule = await createAutomation(db, tn);
    expect((await deliver(commentEvent({ accountId: tn.accountId, from: 'strict_typo', text: 'prcing please' }))).route!.outcome).toBe(Reason.NO_MATCH);
    await db.query(`UPDATE automation_versions SET definition = $2 WHERE automation_id = $1`, [rule.automationId, typoDefinition()]);
    const ev = commentEvent({ accountId: tn.accountId, from: 'typo_dedup', text: 'prcing please' });
    const results = await Promise.all(Array.from({ length: 5 }, () => deliver(ev)));
    const runId = results[0].route!.runId!;
    expect(results.every((r) => r.route!.outcome === Reason.STARTED && r.route!.runId === runId)).toBe(true);
    expect(await count(`SELECT count(*) n FROM outbox WHERE tenant_id = $1 AND kind = 'workflow.start'`, [tn.tenantId])).toBe(1);
    const created = (await db.query(`SELECT data FROM run_audit_events WHERE run_id = $1 AND type = 'run.created'`, [runId])).rows;
    expect(created).toHaveLength(1);
    expect(created[0].data.matchKind).toBe('typo');
    expect(JSON.stringify(created)).not.toContain(ev.text);
    const timeline = await buildTimeline(db, tn.tenantId, runId);
    expect(timeline!.find((e) => e.type === 'run.created')!.text).toContain('matched with typo tolerance');
    const exact = await deliver(commentEvent({ accountId: tn.accountId, from: 'opted_in_exact' }));
    const exactAudit = (await db.query(`SELECT data FROM run_audit_events WHERE run_id = $1 AND type = 'run.created'`, [exact.route!.runId])).rows[0];
    expect(exactAudit.data.matchKind).toBeUndefined();
    expect((await buildTimeline(db, tn.tenantId, exact.route!.runId!))!.find((e) => e.type === 'run.created')!.text).toBe('Rule "pricing" matched; published version 1 started');
  });

  it('an exact match beats higher-priority typo matches and preserves priority/ID ordering among exact rules', async () => {
    const tn = await seedTenant(db);
    const fuzzy = await createAutomation(db, tn, typoDefinition('pricing'), { priority: 100 });
    const low = await createAutomation(db, tn, pricingWith({ keyword: 'prcing' }), { priority: 1 });
    const a = await createAutomation(db, tn, pricingWith({ keyword: 'prcing' }), { priority: 5 });
    const b = await createAutomation(db, tn, pricingWith({ keyword: 'prcing' }), { priority: 5 });
    const winnerId = [a.automationId, b.automationId].sort()[0];
    const { route } = await deliver(commentEvent({ accountId: tn.accountId, from: 'exact_preferred', text: 'prcing' }));
    expect((await db.query(`SELECT automation_id FROM automation_runs WHERE id = $1`, [route!.runId])).rows[0].automation_id).toBe(winnerId);
    const audit = (await db.query(`SELECT reason, data FROM run_audit_events WHERE tenant_id = $1 AND type = 'automation.not_selected'`, [tn.tenantId])).rows;
    expect(audit).toHaveLength(3);
    expect(audit.find((r) => r.data.automationId === fuzzy.automationId).reason).toBe(Reason.EXACT_MATCH_PREFERRED);
    expect(audit.find((r) => r.data.automationId === low.automationId).reason).toBe(Reason.LOWER_PRIORITY);
    expect(audit.filter((r) => r.reason === Reason.LOWER_PRIORITY)).toHaveLength(2);
  });

  it('multiple eligible typo rules are ambiguous regardless of priority and never start or enqueue', async () => {
    const tn = await seedTenant(db);
    await createAutomation(db, tn, typoDefinition(), { priority: 1 });
    await createAutomation(db, tn, typoDefinition(), { priority: 100 });
    const ev = commentEvent({ accountId: tn.accountId, from: 'ambiguous_typo', text: 'prcing please' });
    const first = await deliver(ev);
    expect(first.route).toMatchObject({ outcome: Reason.AMBIGUOUS_KEYWORD, runId: null });
    expect((await deliver(ev)).route).toMatchObject({ outcome: Reason.AMBIGUOUS_KEYWORD, alreadyRouted: true });
    expect(await count(`SELECT count(*) n FROM automation_runs WHERE tenant_id = $1`, [tn.tenantId])).toBe(0);
    expect(await count(`SELECT count(*) n FROM outbox WHERE tenant_id = $1 AND kind LIKE 'workflow.%'`, [tn.tenantId])).toBe(0);
    expect(await count(`SELECT count(*) n FROM message_intents WHERE tenant_id = $1`, [tn.tenantId])).toBe(0);
    const audit = (await db.query(`SELECT reason, data FROM run_audit_events WHERE tenant_id = $1`, [tn.tenantId])).rows;
    expect(audit).toEqual([{ reason: Reason.AMBIGUOUS_KEYWORD, data: { matchKind: 'typo', candidateCount: 2 } }]);
  });

  it('post, active status, account and tenant scope are applied before resolving typo ambiguity', async () => {
    const tn = await seedTenant(db);
    const other = await seedTenant(db);
    const connectionId = await createConnection(db, { tenantId: tn.tenantId, accountId: 'another_typo_account' });
    await db.query(`UPDATE social_connections SET verified_at = now(), integration_kind = 'gateway' WHERE id = $1`, [connectionId]);
    await createAutomation(db, { tenantId: tn.tenantId, connectionId }, typoDefinition());
    await createAutomation(db, other, typoDefinition());
    const filtered = typoDefinition();
    filtered.trigger.posts = { mediaIds: ['only_other_post'] } as any;
    await createAutomation(db, tn, filtered);
    const disabled = await createAutomation(db, tn, typoDefinition());
    await db.query(`UPDATE automations SET status = 'disabled' WHERE id = $1`, [disabled.automationId]);
    expect((await deliver(commentEvent({ accountId: tn.accountId, from: 'no_eligible_typo', text: 'prcing' }))).route!.outcome).toBe(Reason.NO_MATCH);
    const eligible = await createAutomation(db, tn, typoDefinition());
    const { route } = await deliver(commentEvent({ accountId: tn.accountId, from: 'scoped_typo', text: 'prcing' }));
    expect(route!.outcome).toBe(Reason.STARTED);
    expect((await db.query(`SELECT automation_id FROM automation_runs WHERE id = $1`, [route!.runId])).rows[0].automation_id).toBe(eligible.automationId);
  });

  it('typo matches retain connection and conversation suppression policies', async () => {
    const tn = await seedTenant(db);
    await createAutomation(db, tn, typoDefinition());
    const ev = (from: string) => commentEvent({ accountId: tn.accountId, from, text: 'prcing' });
    await db.query(`UPDATE social_connections SET sends_paused = true WHERE id = $1`, [tn.connectionId]);
    expect((await deliver(ev('paused_typo'))).route!.outcome).toBe(Reason.SENDS_PAUSED);
    await db.query(`UPDATE social_connections SET sends_paused = false WHERE id = $1`, [tn.connectionId]);
    expect((await deliver(ev('busy_typo'))).route!.outcome).toBe(Reason.STARTED);
    expect((await deliver(ev('busy_typo'))).route!.outcome).toBe(Reason.CONVERSATION_BUSY);
    expect(await count(`SELECT count(*) n FROM outbox WHERE tenant_id = $1 AND kind = 'workflow.start'`, [tn.tenantId])).toBe(1);
    const suppressed = (await db.query(`SELECT data FROM run_audit_events WHERE tenant_id = $1 AND type = 'trigger.suppressed'`, [tn.tenantId])).rows;
    expect(suppressed).toHaveLength(2);
    expect(suppressed.every((a) => a.data.matchKind === 'typo')).toBe(true);
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

  it('a paused account does not start runs it could not send for (review finding)', async () => {
    const tn = await seedTenant(db);
    await createAutomation(db, tn);
    await db.query(`UPDATE social_connections SET sends_paused = true WHERE id = $1`, [tn.connectionId]);
    expect((await deliver(commentEvent({ accountId: tn.accountId, from: 'paused_p' }))).route!.outcome).toBe(Reason.SENDS_PAUSED);
  });

  it('a run that sent nothing does not start a cooldown (review finding)', async () => {
    const tn = await seedTenant(db);
    await createAutomation(db, tn, pricingWith({}), { cooldownSeconds: 3600 });
    const first = await deliver(commentEvent({ accountId: tn.accountId, from: 'nothing_sent' }));
    await finalizeRun({ db, clock: systemClock } as any, { runId: first.route!.runId!, outcome: 'failed', reason: 'sends_paused' });
    expect((await deliver(commentEvent({ accountId: tn.accountId, from: 'nothing_sent' }))).route!.outcome).toBe(Reason.STARTED);
  });

  it('one event that cannot be routed does not stall the sweeper for the events behind it (review finding)', async () => {
    await routePending(deps());
    const broken = await seedTenant(db);
    const a = await createAutomation(db, broken);
    await db.query(`UPDATE automation_versions SET definition = '{}' WHERE automation_id = $1`, [a.automationId]);
    const healthy = await seedTenant(db);
    await createAutomation(db, healthy);
    const bad = await ingestEvent(deps(), commentEvent({ accountId: broken.accountId, from: 'poison' }));
    const good = await ingestEvent(deps(), commentEvent({ accountId: healthy.accountId, from: 'healthy' }));
    expect(await routePending({ ...deps(), onError: () => undefined }, 1)).toBe(0);
    const retry = (await db.query(`SELECT routing_attempts, next_routing_attempt_at > now() AS deferred FROM inbox_events WHERE id = $1`, [(bad as any).eventId])).rows[0];
    expect(retry).toMatchObject({ routing_attempts: 1, deferred: true });
    expect(await routePending({ ...deps(), onError: () => undefined }, 1)).toBe(1);
    const row = (await db.query(`SELECT routing_outcome FROM inbox_events WHERE id = $1`, [(good as any).eventId])).rows[0];
    expect(row.routing_outcome).toBe(Reason.STARTED);
    expect((await db.query(`SELECT routing_status FROM inbox_events WHERE id = $1`, [(bad as any).eventId])).rows[0].routing_status).toBe('pending');
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
