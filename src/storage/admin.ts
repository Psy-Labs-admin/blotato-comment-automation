import { assertPublishableConnection, OperatorError } from './drafts';
import type { Pool } from 'pg';
import { parseDefinition } from '../domain/definition';
import { withTx } from './db';

export async function createTenant(db: Pool, name: string): Promise<string> {
  return (await db.query(`INSERT INTO tenants (name) VALUES ($1) RETURNING id`, [name])).rows[0].id;
}

/** Creates an automation with version 1 published. The definition is validated before anything is stored. */
export async function createAutomation(
  db: Pool,
  o: { integrationMode?: 'native' | 'gateway' | 'unconfigured'; dispatchConfigured?: boolean; tenantId: string; connectionId: string; name: string; definition: unknown; priority?: number; cooldownSeconds?: number },
): Promise<{ automationId: string; versionId: string; version: number }> {
  const definition = parseDefinition(o.definition);
  return withTx(db, async (c) => {
    await assertPublishableConnection(c, o.tenantId, o.connectionId, o.dispatchConfigured ?? false, o.integrationMode ?? 'unconfigured');
    const automationId = (
      await c.query(
        `INSERT INTO automations (tenant_id, connection_id, name, priority, cooldown_seconds)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [o.tenantId, o.connectionId, o.name, o.priority ?? 0, o.cooldownSeconds ?? 86400],
      )
    ).rows[0].id;
    const versionId = (
      await c.query(
        `INSERT INTO automation_versions (tenant_id, automation_id, version, definition) VALUES ($1, $2, 1, $3) RETURNING id`,
        [o.tenantId, automationId, definition],
      )
    ).rows[0].id;
    await c.query(`UPDATE automations SET active_version_id = $1 WHERE id = $2`, [versionId, automationId]);
    return { automationId, versionId, version: 1 };
  });
}

/** Publishes a new immutable version for new runs. Running runs keep the version they started with. */
export async function publishVersion(
  db: Pool,
  o: { integrationMode?: 'native' | 'gateway' | 'unconfigured'; dispatchConfigured?: boolean; tenantId: string; automationId: string; definition: unknown },
): Promise<{ versionId: string; version: number } | null> {
  const definition = parseDefinition(o.definition);
  return withTx(db, async (c) => {
    const a = await c.query(`SELECT id, connection_id FROM automations WHERE id = $1 AND tenant_id = $2 FOR UPDATE`, [o.automationId, o.tenantId]);
    if (!a.rowCount) return null;
    if ((await c.query('SELECT 1 FROM automation_drafts WHERE automation_id=$1', [o.automationId])).rowCount)
      throw new OperatorError(409, 'edit_draft', 'Edit this rule through its current draft revision.');
    await assertPublishableConnection(c, o.tenantId, a.rows[0].connection_id, o.dispatchConfigured ?? false, o.integrationMode ?? 'unconfigured');
    const version =
      (await c.query(`SELECT coalesce(max(version), 0) + 1 AS v FROM automation_versions WHERE automation_id = $1`, [o.automationId]))
        .rows[0].v;
    const versionId = (
      await c.query(
        `INSERT INTO automation_versions (tenant_id, automation_id, version, definition) VALUES ($1, $2, $3, $4) RETURNING id`,
        [o.tenantId, o.automationId, version, definition],
      )
    ).rows[0].id;
    await c.query(`UPDATE automations SET active_version_id = $1 WHERE id = $2`, [versionId, o.automationId]);
    return { versionId, version };
  });
}

export async function setAutomationStatus(db: Pool, o: { integrationMode?: 'native' | 'gateway' | 'unconfigured'; dispatchConfigured?: boolean; tenantId: string; automationId: string; status: 'active' | 'disabled' }) {
  return withTx(db, async c => {
    const row = (await c.query('SELECT connection_id FROM automations WHERE id=$1 AND tenant_id=$2 FOR UPDATE', [o.automationId,o.tenantId])).rows[0];
    if (!row) return false;
    if (o.status === 'active') await assertPublishableConnection(c, o.tenantId, row.connection_id, o.dispatchConfigured ?? false, o.integrationMode ?? 'unconfigured');
    await c.query('UPDATE automations SET status=$2 WHERE id=$1', [o.automationId, o.status]);
    return true;
  });
}
