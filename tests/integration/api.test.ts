import { createTestAccess } from '../helpers/test-access';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { createTestDb } from '../helpers/db';
import { commentEvent, dmEvent, seedTenant } from '../helpers/fixtures';
import { pricingDefinition } from '../helpers/definitions';
import { buildServer } from '../../src/api/server';
import { systemClock } from '../../src/domain/clock';

describe('HTTP API', () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: Pool;
  let app: FastifyInstance;
  let tn: Awaited<ReturnType<typeof seedTenant>>;
  let other: Awaited<ReturnType<typeof seedTenant>>;
  let automationId: string;
  const auth = createTestAccess();

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    app = buildServer({ db, access: auth.access, dispatchConfigured: true, integrationMode: 'gateway', clock: systemClock, logger: false });
    tn = await seedTenant(db, { name: 'acme' });
    other = await seedTenant(db, { name: 'globex' });
  });
  afterAll(async () => {
    await app?.close();
    await t?.drop();
  });

  const as = auth.operatorHeaders;
  const webhook = (payload: unknown) => app.inject({ method: 'POST', url: '/webhooks/instagram', ...auth.signedWebhook(payload) });

  it('publishes an automation and rejects an invalid definition with readable issues', async () => {
    const bad = await app.inject({
      method: 'POST', url: '/automations', headers: as(tn.tenantId),
      payload: { connectionId: tn.connectionId, name: 'x', definition: { ...pricingDefinition, steps: [] } },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().issues.length).toBeGreaterThan(0);

    const ok = await app.inject({
      method: 'POST', url: '/automations', headers: as(tn.tenantId),
      payload: { connectionId: tn.connectionId, name: 'pricing', definition: pricingDefinition, priority: 1 },
    });
    expect(ok.statusCode).toBe(201);
    automationId = ok.json().automationId;
    expect(ok.json().version).toBe(1);
  });

  it('refuses to attach an automation to another tenant connection', async () => {
    const res = await app.inject({
      method: 'POST', url: '/automations', headers: as(other.tenantId),
      payload: { connectionId: tn.connectionId, name: 'steal', definition: pricingDefinition },
    });
    expect(res.statusCode).toBe(404);
  });

  it('acknowledges webhooks durably: 202 then 202 duplicate; 404 unknown account; 400 malformed', async () => {
    const ev = commentEvent({ accountId: tn.accountId, from: 'api_user' });
    const first = await webhook(ev);
    expect(first.statusCode).toBe(202);
    expect(first.json()).toMatchObject({ duplicate: false });
    expect((await webhook(ev)).json()).toMatchObject({ duplicate: true });
    expect((await webhook(commentEvent({ accountId: 'ig_unknown', from: 'x' }))).statusCode).toBe(404);
    expect((await webhook({ hello: 'world' })).statusCode).toBe(400);
  });

  it('explains what happened to a webhook event (routing outcome and run), scoped to the tenant', async () => {
    const res = await webhook(commentEvent({ accountId: tn.accountId, from: 'event_lookup' }));
    const eventId = res.json().eventId;
    const ev = await app.inject({ method: 'GET', url: `/events/${eventId}`, headers: as(tn.tenantId) });
    expect(ev.statusCode).toBe(200);
    expect(ev.json()).toMatchObject({ eventType: 'comment.created', routingOutcome: 'started' });
    expect(ev.json().runId).toMatch(/[0-9a-f-]{36}/);
    expect((await app.inject({ method: 'GET', url: `/events/${eventId}`, headers: as(other.tenantId) })).statusCode).toBe(404);
  });

  it('cancel writes the control and the workflow command atomically and answers "requested"', async () => {
    await webhook(commentEvent({ accountId: tn.accountId, from: 'to_cancel' }));
    const run = (await db.query(`SELECT r.id FROM automation_runs r JOIN conversations c ON c.id = r.conversation_id WHERE c.participant_id = 'to_cancel'`)).rows[0];
    const res = await app.inject({ method: 'POST', url: `/runs/${run.id}/cancel`, headers: as(tn.tenantId), payload: { reason: 'operator' } });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ status: 'cancel_requested' });
    const ctl = (await db.query(`SELECT cancel_requested FROM run_controls WHERE run_id = $1`, [run.id])).rows[0];
    expect(ctl.cancel_requested).toBe(true);
    expect((await db.query(`SELECT 1 FROM outbox WHERE idempotency_key = $1`, [`cancel:${run.id}`])).rowCount).toBe(1);

    await db.query(`UPDATE automation_runs SET finished_at = now(), status = 'cancelled' WHERE id = $1`, [run.id]);
    await db.query(`UPDATE conversations SET owner_run_id = NULL, last_run_finished_at = now() WHERE participant_id = 'to_cancel'`);
    const again = await app.inject({ method: 'POST', url: `/runs/${run.id}/cancel`, headers: as(tn.tenantId), payload: {} });
    expect(again.statusCode).toBe(409);
  });

  it("another tenant cannot see a run or its timeline", async () => {
    const run = (await db.query(`SELECT id FROM automation_runs WHERE tenant_id = $1 LIMIT 1`, [tn.tenantId])).rows[0];
    expect((await app.inject({ method: 'GET', url: `/runs/${run.id}`, headers: as(other.tenantId) })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/runs/${run.id}/timeline`, headers: as(other.tenantId) })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/runs/${run.id}` })).statusCode).toBe(401);
  });

  it('the timeline explains the run in plain language', async () => {
    const run = (await db.query(`SELECT id FROM automation_runs WHERE tenant_id = $1 ORDER BY created_at LIMIT 1`, [tn.tenantId])).rows[0];
    const res = await app.inject({ method: 'GET', url: `/runs/${run.id}/timeline`, headers: as(tn.tenantId) });
    expect(res.statusCode).toBe(200);
    const texts = res.json().entries.map((e: any) => e.text);
    expect(texts[0]).toMatch(/Comment received/);
    expect(texts.some((x: string) => /matched.*version 1/i.test(x))).toBe(true);
  });

  it('resolving an intent that is not unknown is a conflict', async () => {
    const run = (await db.query(`SELECT id, tenant_id, conversation_id FROM automation_runs WHERE tenant_id = $1 LIMIT 1`, [tn.tenantId])).rows[0];
    const intentId = (
      await db.query(
        `INSERT INTO message_intents (tenant_id, run_id, step_id, action_no, connection_id, conversation_id, kind, target, body, fingerprint, status)
         VALUES ($1, $2, 'public_reply', 1, $3, $4, 'comment_reply', '{}', 'x', 'f', 'accepted') RETURNING id`,
        [tn.tenantId, run.id, tn.connectionId, run.conversation_id],
      )
    ).rows[0].id;
    const res = await app.inject({ method: 'POST', url: `/intents/${intentId}/resolve`, headers: as(tn.tenantId), payload: { resolution: 'accepted', note: 'checked inbox' } });
    expect(res.statusCode).toBe(409);
  });

  it('operator resolve racing with run finalization never strands the conversation (review finding)', async () => {
    const hook = await webhook(commentEvent({ accountId: tn.accountId, from: 'race_user' }));
    const ev = (await app.inject({ method: 'GET', url: `/events/${hook.json().eventId}`, headers: as(tn.tenantId) })).json();
    const intentId = (
      await db.query(
        `INSERT INTO message_intents (tenant_id, run_id, step_id, action_no, connection_id, conversation_id, kind, target, body, fingerprint, status)
         VALUES ($1, $2, 'send_link', 1, $3, $4, 'dm', '{}', 'x', 'f', 'unknown') RETURNING id`,
        [tn.tenantId, ev.runId, tn.connectionId, ev.conversationId],
      )
    ).rows[0].id;
    // A finalizeRun transaction is in progress: it holds the conversation lock and has decided to keep it held.
    const t1 = await db.connect();
    await t1.query('BEGIN');
    await t1.query(`SELECT 1 FROM conversations WHERE id = $1 FOR UPDATE`, [ev.conversationId]);
    await t1.query(`UPDATE automation_runs SET finished_at = now(), status = 'cancelled' WHERE id = $1`, [ev.runId]);
    const resolving = app.inject({
      method: 'POST', url: `/intents/${intentId}/resolve`, headers: as(tn.tenantId), payload: { resolution: 'accepted', note: 'seen in inbox' },
    });
    await new Promise((r) => setTimeout(r, 300));
    await t1.query('COMMIT');
    t1.release();
    expect((await resolving).statusCode).toBe(200);
    const conv = (await db.query(`SELECT owner_run_id FROM conversations WHERE id = $1`, [ev.conversationId])).rows[0];
    expect(conv.owner_run_id).toBeNull();
  });

  it('finds uncertain sends even after the owning run has finished', async () => {
    const reviewTenant = await seedTenant(db, { name: 'uncertain-sends' });
    await app.inject({ method: 'POST', url: '/automations', headers: as(reviewTenant.tenantId),
      payload: { connectionId: reviewTenant.connectionId, name: 'Review', definition: pricingDefinition } });
    const hook = await webhook(commentEvent({ accountId: reviewTenant.accountId, from: 'still_held_after_cancel' }));
    const event = (await app.inject({ url: '/events/' + hook.json().eventId, headers: as(reviewTenant.tenantId) })).json();
    await db.query("UPDATE automation_runs SET status = 'cancelled', finished_at = now() WHERE id = $1", [event.runId]);
    await db.query(
      `INSERT INTO message_intents (tenant_id, run_id, step_id, action_no, connection_id, conversation_id, kind, target, body, fingerprint, status)
       VALUES ($1, $2, 'send_link', 1, $3, $4, 'dm', '{}', 'example', 'f', 'unknown')`,
      [reviewTenant.tenantId, event.runId, reviewTenant.connectionId, event.conversationId],
    );
    const held = (await app.inject({ url: '/runs?needsReview=true', headers: as(reviewTenant.tenantId) })).json();
    expect(held.runs).toContainEqual(expect.objectContaining({ id: event.runId, status: 'cancelled' }));
    expect((await app.inject({ url: '/runs?needsReview=true', headers: as(other.tenantId) })).json().runs).toEqual([]);
  });

  it('funnel counts by run cohort and lists suppression reasons', async () => {
    await webhook(commentEvent({ accountId: tn.accountId, from: 'to_cancel' })); // busy? no: run finished, but cooldown applies
    await webhook(commentEvent({ accountId: tn.accountId, from: 'nobody', text: 'nice post' }));
    await webhook(dmEvent({ accountId: tn.accountId, from: 'nobody', text: 'hi' }));
    const res = await app.inject({ method: 'GET', url: '/funnel', headers: as(tn.tenantId) });
    expect(res.statusCode).toBe(200);
    const f = res.json();
    // api_user, event_lookup, to_cancel and race_user started runs; the second to_cancel comment hit the cooldown.
    expect(f.matchedComments).toBe(5);
    expect(f.runsStarted).toBe(4);
    expect(f.suppressed).toMatchObject({ cooldown: 1 });
    expect(f).toHaveProperty('promptsAccepted');
    expect(f).toHaveProperty('emailsCaptured');
    expect(f).toHaveProperty('runsCompleted');
    expect(f).toHaveProperty('crmSynced');
  });

  it('exposes operational gauges for Prometheus', async () => {
    const res = await app.inject({ method: 'GET', url: '/metrics', headers: auth.metricsHeaders });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatch(/outbox_oldest_pending_seconds/);
    expect(res.body).toMatch(/intents_unknown/);
    expect(res.body).toMatch(/inbox_unrouted_oldest_seconds/);
  });

  it('pausing an account blocks new sends at the gate and is reversible', async () => {
    const p = await app.inject({ method: 'POST', url: `/connections/${tn.connectionId}/pause`, headers: as(tn.tenantId), payload: { reason: 'customer request' } });
    expect(p.statusCode).toBe(200);
    expect((await db.query(`SELECT sends_paused FROM social_connections WHERE id = $1`, [tn.connectionId])).rows[0].sends_paused).toBe(true);
    const r = await app.inject({ method: 'POST', url: `/connections/${tn.connectionId}/resume`, headers: as(tn.tenantId) });
    expect(r.statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: `/connections/${tn.connectionId}/pause`, headers: as(other.tenantId), payload: {} })).statusCode).toBe(404);
  });
});
