import { createConnection } from './account';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { createAutomation as createAutomationRow, createTenant } from '../../src/storage/admin';
import type { Capabilities } from '../../src/domain/types';
import { pricingDefinition } from './definitions';

export async function seedTenant(
  db: Pool,
  o: { name?: string; accountId?: string; capabilities?: Partial<Capabilities> } = {},
): Promise<{ tenantId: string; connectionId: string; accountId: string }> {
  const accountId = o.accountId ?? `ig_${randomUUID().slice(0, 8)}`;
  const tenantId = await createTenant(db, o.name ?? 'acme');
  const connectionId = await createConnection(db, { tenantId, accountId, capabilities: o.capabilities });
  await db.query(
    "UPDATE social_connections SET integration_kind = 'gateway', verified_at = now(), integration_revision = 1, integration_updated_at = now(), display_name = $2 WHERE id = $1",
    [connectionId, o.name ?? 'Test account'],
  );
  return { tenantId, connectionId, accountId };
}

export async function createAutomation(
  db: Pool,
  t: { tenantId: string; connectionId: string },
  definition: unknown = pricingDefinition,
  o: { priority?: number; cooldownSeconds?: number; name?: string } = {},
) {
  return createAutomationRow(db, {
    dispatchConfigured: true, integrationMode: 'gateway',
    tenantId: t.tenantId,
    connectionId: t.connectionId,
    name: o.name ?? 'pricing',
    definition,
    priority: o.priority,
    cooldownSeconds: o.cooldownSeconds,
  });
}

export function commentEvent(o: {
  accountId: string;
  from: string;
  text?: string;
  commentId?: string;
  mediaId?: string;
  occurredAt?: string;
}) {
  return {
    type: 'comment.created',
    accountId: o.accountId,
    commentId: o.commentId ?? `c_${randomUUID().slice(0, 8)}`,
    mediaId: o.mediaId ?? 'media_1',
    from: { id: o.from, username: `${o.from}_name` },
    text: o.text ?? 'pricing please',
    occurredAt: o.occurredAt ?? new Date().toISOString(),
  };
}

export function dmEvent(o: { accountId: string; from: string; text: string; messageId?: string; isEcho?: boolean }) {
  return {
    type: 'message.received',
    accountId: o.accountId,
    messageId: o.messageId ?? `m_${randomUUID().slice(0, 8)}`,
    from: { id: o.from },
    text: o.text,
    occurredAt: new Date().toISOString(),
    isEcho: o.isEcho ?? false,
  };
}
