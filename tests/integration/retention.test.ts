import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb } from '../helpers/db';
import { commentEvent, createAutomation, seedTenant } from '../helpers/fixtures';
import { ingestEvent } from '../../src/ingest/ingest';
import { routeEvent } from '../../src/ingest/router';
import { systemClock } from '../../src/domain/clock';
import { redactExpiredInbox } from '../../src/storage/retention';
import { finalizeRun } from '../../src/activities/runs';

describe('opt-in inbox retention on synthetic data', () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  beforeAll(async () => { t = await createTestDb(); });
  afterAll(async () => t?.drop());

  async function oldComment(options: { routed?: boolean; active?: boolean; unknown?: boolean; preparedWait?: boolean; recent?: boolean } = {}) {
    const { db } = t;
    const tenant = await seedTenant(db);
    if (options.active || options.unknown || options.preparedWait) await createAutomation(db, tenant);
    const result = await ingestEvent({ db, clock: systemClock }, commentEvent({ accountId: tenant.accountId, from: 'person', text: 'pricing synthetic personal text' }));
    if (result.status !== 'accepted') throw new Error('ingest failed');
    let runId: string | null = null;
    if (options.routed !== false) runId = (await routeEvent({ db, clock: systemClock }, result.eventId)).runId;
    if (!options.recent) await db.query(`UPDATE inbox_events SET received_at = now() - interval '90 days' WHERE id = $1`, [result.eventId]);
    if (options.unknown) {
      await db.query(
        `INSERT INTO message_intents (tenant_id, run_id, step_id, action_no, connection_id, conversation_id, kind, target, body, fingerprint, status)
         SELECT tenant_id, id, 'ask_email', 1, $2, conversation_id, 'private_reply', '{}', 'question', 'f', 'unknown'
           FROM automation_runs WHERE id = $1`, [runId, tenant.connectionId],
      );
    }
    if (options.preparedWait) {
      await db.query(
        `INSERT INTO input_waits (tenant_id, run_id, step_id, prompt_step_id, conversation_id, status, timeout_ms, max_clarifications)
         SELECT tenant_id, id, 'email', 'ask_email', conversation_id, 'prepared', 1000, 1 FROM automation_runs WHERE id = $1`, [runId],
      );
    }
    if (runId && !options.active) {
      // Keep an explicitly prepared wait as synthetic inconsistent historical state to
      // prove retention checks it independently of run/ownership projections.
      if (options.preparedWait) {
        await db.query(`UPDATE automation_runs SET finished_at = now(), status = 'failed' WHERE id = $1`, [runId]);
        await db.query(`UPDATE conversations SET owner_run_id = NULL WHERE owner_run_id = $1`, [runId]);
      } else {
        await finalizeRun({ db, clock: systemClock }, { runId, outcome: 'completed' });
      }
    }
    return { eventId: result.eventId, tenant, runId };
  }
  const text = async (eventId: string) => (await t.db.query(`SELECT text, text_redacted_at FROM inbox_events WHERE id = $1`, [eventId])).rows[0];

  it('does nothing by default and redacts only old routed quiescent conversations when opted in', async () => {
    const eligible = await oldComment();
    const pending = await oldComment({ routed: false });
    const active = await oldComment({ active: true });
    const unknown = await oldComment({ unknown: true });
    const prepared = await oldComment({ preparedWait: true });
    const recent = await oldComment({ recent: true });
    expect(await redactExpiredInbox(t.db, { enabled: false })).toBe(0);
    expect((await text(eligible.eventId)).text).toContain('synthetic');
    expect(await redactExpiredInbox(t.db, { enabled: true, olderThanDays: 30 })).toBe(1);
    expect(await text(eligible.eventId)).toMatchObject({ text: '[redacted]', text_redacted_at: expect.any(Date) });
    for (const event of [pending, active, unknown, prepared, recent]) {
      expect(await text(event.eventId)).toMatchObject({ text: 'pricing synthetic personal text', text_redacted_at: null });
    }
    expect(await redactExpiredInbox(t.db, { enabled: true })).toBe(0);
  });

  it('bounds each batch and leaves decisions and event identity intact', async () => {
    const first = await oldComment();
    const second = await oldComment();
    expect(await redactExpiredInbox(t.db, { enabled: true, batchSize: 1 })).toBe(1);
    expect(await redactExpiredInbox(t.db, { enabled: true, batchSize: 1 })).toBe(1);
    const events = await t.db.query(`SELECT id, routing_outcome FROM inbox_events WHERE id = ANY($1::uuid[])`, [[first.eventId, second.eventId]]);
    expect(events.rows).toHaveLength(2);
    expect(events.rows.every((row) => row.routing_outcome === 'no_match')).toBe(true);
    expect((await t.db.query(`SELECT count(*)::int AS n FROM inbox_events WHERE text_redacted_at IS NOT NULL`)).rows[0].n).toBe(3);
  });
});
