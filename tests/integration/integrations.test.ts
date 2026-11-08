import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb } from '../helpers/db';
import { commentEvent, createAutomation, seedTenant } from '../helpers/fixtures';
import { ingestEvent } from '../../src/ingest/ingest';
import { routeEvent } from '../../src/ingest/router';
import { systemClock } from '../../src/domain/clock';
import { integrationHandlers } from '../../src/relay/integrations';
import type { OutboxRow } from '../../src/relay/relay';
import { temporalHandlers } from '../../src/temporal/handlers';
import type { Client } from '@temporalio/client';

describe('CRM delivery recovery', () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  beforeAll(async () => { t = await createTestDb(); });
  afterAll(async () => t?.drop());

  async function pendingLead() {
    const { db } = t;
    const tenant = await seedTenant(db);
    await createAutomation(db, tenant);
    const event = await ingestEvent({ db, clock: systemClock }, commentEvent({ accountId: tenant.accountId, from: 'person' }));
    if (event.status !== 'accepted') throw new Error('ingest failed');
    const run = await routeEvent({ db, clock: systemClock }, event.eventId);
    const lead = (await db.query(
      `INSERT INTO leads (tenant_id, connection_id, conversation_id, participant_id, run_id, source_event_id, email)
       SELECT tenant_id, $2, conversation_id, 'person', id, trigger_event_id, 'person@example.com'
         FROM automation_runs WHERE id = $1 RETURNING *`, [run.runId, tenant.connectionId],
    )).rows[0];
    const row: OutboxRow = { id: 'test', tenantId: tenant.tenantId, kind: 'crm.lead_captured',
      idempotencyKey: `crm:${lead.id}`, payload: { leadId: lead.id }, attempts: 2 };
    return { tenant, lead, row };
  }

  it('retains pending work when optional CRM and alert delivery have not been configured', async () => {
    const { row, lead } = await pendingLead();
    const handlers = integrationHandlers({ db: t.db });
    expect(await handlers['crm.lead_captured'](row)).toMatchObject({ retryInMs: 60_000 });
    expect((await t.db.query('SELECT crm_status FROM leads WHERE id = $1', [lead.id])).rows[0].crm_status).toBe('pending');
    expect(await handlers['alert.notify']({ ...row, kind: 'alert.notify', payload: { incidentId: 'unread-without-delivery', kind: 'opened' } })).toMatchObject({ retryInMs: 60_000 });
  });

  it('rejects cross-tenant CRM references and skips already synced leads before external delivery', async () => {
    const {row, lead} = await pendingLead();
    const other = await seedTenant(t.db); let calls = 0;
    const handler = integrationHandlers({db:t.db,crm:{upsertLead:async()=>{calls++;}}})['crm.lead_captured'];
    await expect(handler({...row,tenantId:other.tenantId})).rejects.toMatchObject({code:'crm_scope_invalid'});
    await expect(handler({...row,tenantId:null})).rejects.toMatchObject({code:'crm_scope_invalid'});
    await t.db.query("UPDATE leads SET crm_status='synced' WHERE id=$1",[lead.id]);
    await handler(row); expect(calls).toBe(0);
  });

  it('does not reopen a CRM incident for a stale failure after another handler synced the lead', async () => {
    const { db } = t;
    const { tenant, row } = await pendingLead();
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const handler = integrationHandlers({ db, crm: { upsertLead: async () => {
      if (++calls === 1) { entered(); await blocked; throw new Error('stale network error'); }
    } }, notifier: { notify: async () => {} } })['crm.lead_captured'];
    const first = handler(row);
    const failed = expect(first).rejects.toThrow('stale network error');
    await started;
    await handler(row);
    release();
    await failed;
    expect((await db.query(`SELECT 1 FROM incidents WHERE connection_id = $1 AND status = 'open'`, [tenant.connectionId])).rowCount).toBe(0);
  });

  it('locks the conversation before the connection while recording CRM success', async () => {
    const { db } = t;
    const { tenant, lead, row } = await pendingLead();
    const c = await db.connect();
    let delivery: Promise<unknown> | undefined;
    try {
      await c.query('BEGIN');
      await c.query(`SELECT id FROM conversations WHERE id = $1 FOR UPDATE`, [lead.conversation_id]);
      const holderPid = (await c.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      const handler = integrationHandlers({ db, crm: { upsertLead: async () => {} }, notifier: { notify: async () => {} } })['crm.lead_captured'];
      let deliveryFinished = false;
      delivery = handler(row).finally(() => { deliveryFinished = true; });
      const deadline = Date.now() + 10_000;
      for (;;) {
        const waiting = await db.query(
          `SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND $1 = ANY(pg_blocking_pids(pid))`,
          [holderPid],
        );
        if (waiting.rowCount) break;
        if (deliveryFinished) throw new Error('CRM delivery finished without the required conversation lock');
        if (Date.now() > deadline) throw new Error('CRM handler did not wait for the conversation lock');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await c.query(`SET LOCAL lock_timeout = '400ms'`);
      await c.query(`SELECT id FROM social_connections WHERE id = $1 FOR NO KEY UPDATE`, [tenant.connectionId]);
      await c.query('COMMIT');
      await delivery;
    } finally {
      await c.query('ROLLBACK');
      await delivery?.catch(() => undefined);
      c.release();
    }
  });

  it('drops an old start for a finished run even after Temporal retention', async () => {
    const { db } = t;
    const { lead } = await pendingLead();
    await db.query(`UPDATE automation_runs SET status = 'completed', finished_at = now() WHERE id = $1`, [lead.run_id]);
    let starts = 0;
    const client = { workflow: { start: async () => { starts += 1; } } } as unknown as Client;
    const handler = temporalHandlers({ db, client, taskQueue: 'test' })['workflow.start'];
    await handler({ id: 'test', tenantId: lead.tenant_id, kind: 'workflow.start', idempotencyKey: `start:${lead.run_id}`,
      payload: { runId: lead.run_id }, attempts: 0 });
    expect(starts).toBe(0);
  });

  it('keeps an account incident open until all leads sync and audits redelivery once', async () => {
    const { db } = t;
    const tenant = await seedTenant(db);
    await createAutomation(db, tenant);
    const rows: OutboxRow[] = [];
    for (const user of ['first', 'second']) {
      const event = await ingestEvent({ db, clock: systemClock }, commentEvent({ accountId: tenant.accountId, from: user }));
      if (event.status !== 'accepted') throw new Error('ingest failed');
      const run = await routeEvent({ db, clock: systemClock }, event.eventId);
      const lead = (await db.query(
        `INSERT INTO leads (tenant_id, connection_id, conversation_id, participant_id, run_id, source_event_id, email)
         SELECT tenant_id, $2, conversation_id, $3, id, trigger_event_id, $4 FROM automation_runs WHERE id = $1 RETURNING id`,
        [run.runId, tenant.connectionId, user, `${user}@example.com`],
      )).rows[0];
      rows.push({ id: String(rows.length + 1), tenantId: tenant.tenantId, kind: 'crm.lead_captured',
        idempotencyKey: `crm:${lead.id}`, payload: { leadId: lead.id }, attempts: 2 });
    }
    let down = true;
    const handler = integrationHandlers({ db, crm: { upsertLead: async () => { if (down) throw new Error('offline'); } },
      notifier: { notify: async () => {} } })['crm.lead_captured'];
    for (const row of rows) await expect(handler(row)).rejects.toThrow('offline');
    down = false;
    await handler(rows[0]);
    const incident = async () => (await db.query(
      `SELECT status FROM incidents WHERE connection_id = $1 AND error_class = 'crm_delivery_failing'`,
      [tenant.connectionId],
    )).rows[0];
    expect(await incident()).toMatchObject({ status: 'open' });
    await handler(rows[0]);
    expect((await db.query(`SELECT count(*)::int AS n FROM run_audit_events WHERE type = 'crm.synced' AND tenant_id = $1`, [tenant.tenantId])).rows[0].n).toBe(1);
    await handler(rows[1]);
    expect(await incident()).toMatchObject({ status: 'resolved' });
  });
});
