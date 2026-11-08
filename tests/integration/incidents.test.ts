import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb } from '../helpers/db';
import { commentEvent, createAutomation, seedTenant } from '../helpers/fixtures';
import { ingestEvent } from '../../src/ingest/ingest';
import { routeEvent } from '../../src/ingest/router';
import { systemClock } from '../../src/domain/clock';
import { raiseIncident, settleUnknownIncident } from '../../src/alerts/incidents';
import { withTx } from '../../src/storage/db';

describe('unknown-send incident accounting', () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  beforeAll(async () => { t = await createTestDb(); });
  afterAll(async () => t?.drop());

  it('keeps an incident open when another conversation becomes unknown during resolution', async () => {
    const { db } = t;
    const tenant = await seedTenant(db);
    await createAutomation(db, tenant);
    const intents: string[] = [];
    for (const user of ['original', 'new_unknown']) {
      const event = await ingestEvent({ db, clock: systemClock }, commentEvent({ accountId: tenant.accountId, from: user }));
      if (event.status !== 'accepted') throw new Error('ingest failed');
      const run = await routeEvent({ db, clock: systemClock }, event.eventId);
      intents.push((await db.query(
        `INSERT INTO message_intents (tenant_id, run_id, step_id, action_no, connection_id, conversation_id,
          kind, target, body, fingerprint, status)
         SELECT tenant_id, id, 'reply', 1, $2, conversation_id, 'comment_reply', '{}', 'hello', 'f', $3
           FROM automation_runs WHERE id = $1 RETURNING id`,
        [run.runId, tenant.connectionId, user === 'original' ? 'unknown' : 'accepted'],
      )).rows[0].id);
    }
    const scope = { tenantId: tenant.tenantId, connectionId: tenant.connectionId };
    await withTx(db, (c) => raiseIncident(c, { ...scope, errorClass: 'send_outcome_unknown' }));
    const first = await db.connect();
    const second = await db.connect();
    let settling: Promise<void> | undefined;
    try {
      await first.query('BEGIN');
      await first.query(`UPDATE message_intents SET status = 'unknown' WHERE id = $1`, [intents[1]]);
      await raiseIncident(first, { ...scope, errorClass: 'send_outcome_unknown' });
      await second.query('BEGIN');
      await second.query(`UPDATE message_intents SET status = 'accepted' WHERE id = $1`, [intents[0]]);
      settling = settleUnknownIncident(second, scope);
      // Both implementations wait here. The old implementation counts before waiting on
      // the incident row, so it closes the newly raised incident after the first commit.
      await new Promise((resolve) => setTimeout(resolve, 50));
      await first.query('COMMIT');
      await settling;
      await second.query('COMMIT');
      expect((await db.query(`SELECT status FROM incidents WHERE connection_id = $1`, [tenant.connectionId])).rows[0].status).toBe('open');
    } finally {
      await first.query('ROLLBACK');
      await settling?.catch(() => undefined);
      await second.query('ROLLBACK');
      first.release();
      second.release();
    }
  });
});
