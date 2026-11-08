import type { Pool, PoolClient } from 'pg';
import type { AlertNotifier } from '../adapters/alerts';
import type { CrmClient } from '../adapters/crm';
import { formatIncident } from '../alerts/format';
import { raiseIncident, resolveIncident } from '../alerts/incidents';
import { audit } from '../storage/audit';
import { withTx } from '../storage/db';
import type { AlertNotifyPayload, LeadCapturedPayload } from '../storage/outbox';
import type { OutboxHandler, OutboxRow } from './relay';

/** After this many consecutive failures a CRM outage becomes an incident (the dialogue is unaffected). */
const CRM_INCIDENT_AFTER = 3;

export function integrationHandlers(o: { db: Pool; crm?: CrmClient; notifier?: AlertNotifier; consoleUrl?: string }): {
  'crm.lead_captured': OutboxHandler;
  'alert.notify': OutboxHandler;
} {
  return {
    'crm.lead_captured': async (row) => {
      const crm = o.crm;
      if (!crm) return { retryInMs: 60_000, reason: 'CRM delivery is not configured' };
      const { leadId } = row.payload as LeadCapturedPayload;
      const lead = (
        await o.db.query(
          `SELECT l.*, e.comment_id, e.media_id FROM leads l
             JOIN automation_runs r ON r.id = l.run_id JOIN inbox_events e ON e.id = r.trigger_event_id
            WHERE l.id = $1`,
          [leadId],
        )
      ).rows[0];
      if (!lead) throw new Error(`lead ${leadId} not found`);
      try {
        // The outbox key doubles as the CRM idempotency key: redelivery upserts the same record.
        await crm.upsertLead(
          { eventId: row.idempotencyKey, leadId, tenantId: lead.tenant_id, email: lead.email, source: { runId: lead.run_id, commentId: lead.comment_id, mediaId: lead.media_id } },
          row.idempotencyKey,
        );
      } catch (err) {
        if (row.attempts + 1 >= CRM_INCIDENT_AFTER) {
          await withTx(o.db, async (c) => {
            await c.query(`SELECT id FROM conversations WHERE id = $1 FOR UPDATE`, [lead.conversation_id]);
            await c.query(`SELECT id FROM social_connections WHERE id = $1 FOR NO KEY UPDATE`, [lead.connection_id]);
            const current = (await c.query(`SELECT crm_status FROM leads WHERE id = $1 FOR UPDATE`, [leadId])).rows[0];
            if (current?.crm_status !== 'synced') {
              await raiseIncident(c, { tenantId: lead.tenant_id, connectionId: lead.connection_id, errorClass: 'crm_delivery_failing', runId: lead.run_id });
            }
          });
        }
        throw err;
      }
      await withTx(o.db, async (c) => {
        await c.query(`SELECT id FROM conversations WHERE id = $1 FOR UPDATE`, [lead.conversation_id]);
        await c.query(`SELECT id FROM social_connections WHERE id = $1 FOR NO KEY UPDATE`, [lead.connection_id]);
        const synced = await c.query(
          `UPDATE leads SET crm_status = 'synced', crm_synced_at = now() WHERE id = $1 AND crm_status <> 'synced'`,
          [leadId],
        );
        if (synced.rowCount) {
          await audit(c, { tenantId: lead.tenant_id, runId: lead.run_id, conversationId: lead.conversation_id, type: 'crm.synced', data: { leadId } });
        }
        const backlog = await c.query(
          `SELECT 1 FROM leads WHERE connection_id = $1 AND crm_status <> 'synced' LIMIT 1`,
          [lead.connection_id],
        );
        if (!backlog.rowCount) {
          await resolveIncident(c, { tenantId: lead.tenant_id, connectionId: lead.connection_id, errorClass: 'crm_delivery_failing' });
        }
      });
    },

    'alert.notify': async (row) => {
      const notifier = o.notifier;
      if (!notifier) return { retryInMs: 60_000, reason: 'Alert delivery is not configured' };
      const { incidentId, kind } = row.payload as AlertNotifyPayload;
      const inc = (
        await o.db.query(
          `SELECT i.*, t.name AS tenant_name, sc.external_account_id AS account FROM incidents i
             JOIN tenants t ON t.id = i.tenant_id LEFT JOIN social_connections sc ON sc.id = i.connection_id
            WHERE i.id = $1`,
          [incidentId],
        )
      ).rows[0];
      if (!inc) return;
      await notifier.notify(formatIncident(inc, kind, o.consoleUrl));
    },
  };
}

/** Dead-lettered outbox rows are kept for inspection and surfaced as an incident (never silently dropped). */
export async function onDeadLetter(c: PoolClient, row: OutboxRow, _error: string): Promise<void> {
  if (!row.tenantId) return;
  if (row.kind === 'crm.lead_captured') {
    await c.query(
      'SELECT 1 FROM conversations WHERE id = (SELECT conversation_id FROM leads WHERE id = $1 AND tenant_id = $2) FOR NO KEY UPDATE',
      [row.payload.leadId, row.tenantId],
    );
    const lead = (await c.query(
      `UPDATE leads SET crm_status = 'failed' WHERE id = $1 AND tenant_id = $2 AND crm_status <> 'synced' RETURNING run_id, conversation_id`,
      [row.payload.leadId, row.tenantId],
    )).rows[0];
    if (lead) await audit(c, { tenantId: row.tenantId, runId: lead.run_id, conversationId: lead.conversation_id, type: 'crm.failed' });
  }
  if (row.kind !== 'alert.notify') {
    await raiseIncident(c, { tenantId: row.tenantId, errorClass: 'outbox_dead_letter' });
  }
}
