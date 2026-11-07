import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createTestDb } from '../helpers/db';

describe('schema invariants', () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: Pool;
  let tenantId: string;
  let connectionId: string;
  let conversationId: string;

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    tenantId = (await db.query(`INSERT INTO tenants (name) VALUES ('acme') RETURNING id`)).rows[0].id;
    connectionId = (
      await db.query(
        `INSERT INTO social_connections (tenant_id, platform, external_account_id)
         VALUES ($1, 'instagram', 'ig_1') RETURNING id`,
        [tenantId],
      )
    ).rows[0].id;
    conversationId = (
      await db.query(
        `INSERT INTO conversations (tenant_id, connection_id, participant_id)
         VALUES ($1, $2, 'user_1') RETURNING id`,
        [tenantId, connectionId],
      )
    ).rows[0].id;
  });
  afterAll(async () => t?.drop());

  const insertInbox = (key: string, seq: number) =>
    db.query(
      `INSERT INTO inbox_events (tenant_id, connection_id, conversation_id, event_type, provider_event_key,
         seq, participant_id, text, occurred_at, received_at)
       VALUES ($1, $2, $3, 'comment.created', $4, $5, 'user_1', 'pricing', now(), now()) RETURNING id`,
      [tenantId, connectionId, conversationId, key, seq],
    );

  it('rejects a duplicate inbox event key', async () => {
    await insertInbox('c1', 1);
    await expect(insertInbox('c1', 2)).rejects.toMatchObject({ code: '23505' });
  });

  it('rejects a second consumption of one inbox event', async () => {
    const eventId = (await insertInbox('c2', 3)).rows[0].id;
    const automationId = (
      await db.query(
        `INSERT INTO automations (tenant_id, connection_id, name) VALUES ($1, $2, 'a') RETURNING id`,
        [tenantId, connectionId],
      )
    ).rows[0].id;
    const versionId = (
      await db.query(
        `INSERT INTO automation_versions (tenant_id, automation_id, version, definition)
         VALUES ($1, $2, 1, '{}') RETURNING id`,
        [tenantId, automationId],
      )
    ).rows[0].id;
    const runId = '00000000-0000-4000-8000-000000000001';
    await db.query(
      `INSERT INTO automation_runs (id, tenant_id, automation_id, version_id, conversation_id, trigger_event_id,
         workflow_id, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'wf-1', 'starting')`,
      [runId, tenantId, automationId, versionId, conversationId, eventId],
    );
    const waitId = (
      await db.query(
        `INSERT INTO input_waits (tenant_id, run_id, step_id, prompt_step_id, conversation_id, status,
           timeout_ms, max_clarifications)
         VALUES ($1, $2, 'email', 'ask_email', $3, 'active', 1000, 1) RETURNING id`,
        [tenantId, runId, conversationId],
      )
    ).rows[0].id;
    const consume = () =>
      db.query(
        `INSERT INTO input_consumptions (inbox_event_id, wait_id, tenant_id, result) VALUES ($1, $2, $3, 'valid')`,
        [eventId, waitId, tenantId],
      );
    await consume();
    await expect(consume()).rejects.toMatchObject({ code: '23505' });
  });

  it('rejects a conversation that points at another tenant connection', async () => {
    const other = (await db.query(`INSERT INTO tenants (name) VALUES ('other') RETURNING id`)).rows[0].id;
    await expect(
      db.query(
        `INSERT INTO conversations (tenant_id, connection_id, participant_id) VALUES ($1, $2, 'user_x')`,
        [other, connectionId],
      ),
    ).rejects.toMatchObject({ code: '23503' });
  });
});
