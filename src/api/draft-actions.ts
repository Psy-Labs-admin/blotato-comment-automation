import type { Pool } from 'pg';
import { z } from 'zod';
import type { Clock } from '../domain/clock';
import type { IntegrationMode } from '../domain/types';
import { withTx } from '../storage/db';
import {
  assertPublishableConnection,
  DraftContentSchema,
  draftDefinition,
  draftDto,
  connectionIssue,
  OperatorError,
} from '../storage/drafts';
export interface DraftDeps {
  db: Pool;
  clock: Clock;
  dispatchConfigured: boolean;
  integrationMode?: IntegrationMode;
}
const Uuid = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());
const Name = z.string().trim().min(1).max(200);
const CreateDraft = z
  .object({ name: Name, content: DraftContentSchema.optional(), connectionId: Uuid.optional() })
  .strict();
const EditDraft = z
  .object({
    expectedRevision: z.number().int().positive(),
    name: Name.optional(),
    content: DraftContentSchema.optional(),
    connectionId: Uuid.nullable().optional(),
  })
  .strict();
const Revision = z.object({ expectedRevision: z.number().int().positive() }).strict();

export async function createDraft(deps: DraftDeps, tenant: string, body: unknown) {
  const { db } = deps;
  const input = CreateDraft.parse(body);
  if (
    input.connectionId &&
    !(
      await db.query('SELECT 1 FROM social_connections WHERE id = $1 AND tenant_id = $2', [
        input.connectionId,
        tenant,
      ])
    ).rowCount
  ) {
    throw new OperatorError(404, 'account_not_found', 'Account not found.');
  }
  const row = (
    await db.query(
      'INSERT INTO automation_drafts (tenant_id, name, content, connection_id) VALUES ($1, $2, $3, $4) RETURNING *',
      [tenant, input.name, input.content ?? {}, input.connectionId ?? null],
    )
  ).rows[0];
  return { draft: draftDto(row) };
}
export async function editDraft(deps: DraftDeps, tenant: string, id: string, body: unknown) {
  const { db } = deps;
  const input = EditDraft.parse(body);
  const row = await withTx(db, async (c) => {
    const current = (
      await c.query('SELECT * FROM automation_drafts WHERE id = $1 AND tenant_id = $2 FOR UPDATE', [id, tenant])
    ).rows[0];
    if (!current) throw new OperatorError(404, 'draft_not_found', 'Automation not found.');
    if (current.revision !== input.expectedRevision)
      throw new OperatorError(
        409,
        'revision_conflict',
        'This automation was edited in another window. Reload before saving.',
      );
    if (
      input.connectionId &&
      !(
        await c.query('SELECT 1 FROM social_connections WHERE id = $1 AND tenant_id = $2', [
          input.connectionId,
          tenant,
        ])
      ).rowCount
    ) {
      throw new OperatorError(404, 'account_not_found', 'Account not found.');
    }
    return (
      await c.query(
        `UPDATE automation_drafts SET name = $3, content = $4, connection_id = $5, revision = revision + 1, updated_at = now()
                          WHERE id = $1 AND tenant_id = $2 RETURNING *`,
        [
          id,
          tenant,
          input.name ?? current.name,
          input.content ?? current.content,
          input.connectionId === undefined ? current.connection_id : input.connectionId,
        ],
      )
    ).rows[0];
  });
  return { draft: draftDto(row) };
}
export async function publishDraft(deps: DraftDeps, tenant: string, id: string, body: unknown) {
  const { db } = deps;
  const mode = deps.integrationMode ?? 'unconfigured';
  const input = Revision.parse(body);
  return withTx(db, async (c) => {
    const draft = (
      await c.query('SELECT * FROM automation_drafts WHERE id = $1 AND tenant_id = $2 FOR UPDATE', [id, tenant])
    ).rows[0];
    if (!draft) throw new OperatorError(404, 'draft_not_found', 'Automation not found.');
    if (draft.revision !== input.expectedRevision)
      throw new OperatorError(409, 'revision_conflict', 'This automation changed. Reload before publishing.');
    if (draft.published_revision === draft.revision) {
      const existing = (
        await c.query(
          'SELECT v.version, a.status FROM automation_versions v JOIN automations a ON a.id = v.automation_id WHERE v.id = $1',
          [draft.published_version_id],
        )
      ).rows[0];
      return {
        draft: draftDto({ ...draft, automation_status: existing.status }),
        automationId: draft.automation_id,
        versionId: draft.published_version_id,
        version: existing.version,
      };
    }
    if (!draft.connection_id)
      throw new OperatorError(409, 'account_required', 'Choose a connected Instagram account before publishing.');
    const definition = draftDefinition(draft.content);
    await assertPublishableConnection(c, tenant, draft.connection_id, deps.dispatchConfigured, mode);
    let automationId = draft.automation_id;
    if (!automationId) {
      automationId = (
        await c.query(
          `INSERT INTO automations (tenant_id, connection_id, name, status) VALUES ($1, $2, $3, 'disabled') RETURNING id`,
          [tenant, draft.connection_id, draft.name],
        )
      ).rows[0].id;
    } else {
      await c.query('SELECT 1 FROM automations WHERE id = $1 FOR UPDATE', [automationId]);
    }
    const version = (
      await c.query(
        'SELECT coalesce(max(version), 0) + 1 AS n FROM automation_versions WHERE automation_id = $1',
        [automationId],
      )
    ).rows[0].n;
    const versionId = (
      await c.query(
        'INSERT INTO automation_versions (tenant_id, automation_id, version, definition) VALUES ($1, $2, $3, $4) RETURNING id',
        [tenant, automationId, version, definition],
      )
    ).rows[0].id;
    await c.query(
      `UPDATE automations SET active_version_id = $2, status = 'active', name = $3, connection_id = $4 WHERE id = $1`,
      [automationId, versionId, draft.name, draft.connection_id],
    );
    const saved = (
      await c.query(
        'UPDATE automation_drafts SET automation_id = $2, published_revision = revision, published_version_id = $3, updated_at = now() WHERE id = $1 RETURNING *',
        [id, automationId, versionId],
      )
    ).rows[0];
    return { draft: draftDto(saved), automationId, versionId, version };
  });
}

export async function listAccounts(deps: DraftDeps, tenant: string) {
  const { db } = deps;
  const mode = deps.integrationMode ?? 'unconfigured';
  const accounts = await db.query(
    `SELECT sc.id, sc.external_account_id, sc.display_name, sc.status, sc.verified_at, sc.sends_paused, sc.capabilities, sc.integration_kind, i.expires_at AS native_expires_at
     FROM social_connections sc LEFT JOIN instagram_credentials i ON i.connection_id = sc.id
     WHERE sc.tenant_id = $1 ORDER BY sc.created_at, sc.id`,
    [tenant],
  );
  return {
    accounts: accounts.rows.map((account) => ({
      id: account.id,
      accountId: account.external_account_id,
      displayName: account.display_name ?? account.external_account_id,
      source: account.integration_kind ?? (account.native_expires_at ? 'native' : null),
      canDisconnect: account.integration_kind === 'native' && account.status !== 'disconnected',
      status: account.status,
      verifiedAt: account.verified_at,
      paused: account.sends_paused,
      canPublish: !connectionIssue(account, deps.dispatchConfigured, mode, deps.clock.now()),
      issue: connectionIssue(account, deps.dispatchConfigured, mode, deps.clock.now()),
    })),
  };
}
