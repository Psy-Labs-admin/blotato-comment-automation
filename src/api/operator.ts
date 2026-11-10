import { createHash } from 'node:crypto';
import { isUtf8 } from 'node:buffer';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import type { IntegrationMode } from '../domain/types';
import type { Clock } from '../domain/clock';
import { DefinitionError } from '../domain/definition';
import { withTx } from '../storage/db';
import { storableText } from '../storage/text';
import { providerId, eventTimestamp } from '../ingest/events';
import { resolveIncident } from '../alerts/incidents';
import { draftDto, connectionIssue, OperatorError } from '../storage/drafts';
import { createDraft, editDraft, publishDraft, listAccounts } from './draft-actions';
import { validWebhook } from './access';

interface OperatorDeps {
  db: Pool;
  clock: Clock;
  dispatchConfigured: boolean;
  integrationMode?: IntegrationMode;
  provisioningSecret?: string;
  integrationSettingsUrl?: string;
}
type TenantOf = (req: FastifyRequest, reply: FastifyReply) => string | undefined;
const Uuid = z.string().uuid().transform((value) => value.toLowerCase());
const Capabilities = z.object({
  privateReplyWindowHours: z.number().finite().nonnegative(), messagingWindowHours: z.number().finite().nonnegative(),
  sendsPerWindow: z.number().int().nonnegative(), budgetWindowSeconds: z.number().finite().positive(),
  recipientHourlyLimit: z.number().int().nonnegative(), reconciliation: z.enum(['lookup_by_client_ref', 'none']),
}).strict();
const AccountEvent = z.object({
  type: z.literal('instagram.account.updated'), eventId: Uuid, tenantId: Uuid, accountId: providerId,
  displayName: storableText.trim().min(1).max(200), status: z.enum(['active', 'disconnected', 'unauthorized']),
  capabilities: Capabilities, integrationRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  occurredAt: eventTimestamp,
}).strict();

async function respond(reply: FastifyReply, run: () => Promise<unknown>): Promise<unknown> {
  try { return await run(); }
  catch (error) {
    if (error instanceof OperatorError) return reply.code(error.status).send({ error: error.message, code: error.code });
    if (error instanceof DefinitionError) return reply.code(400).send({ error: 'Complete the automation before publishing.', issues: error.issues });
    if (error instanceof z.ZodError) return reply.code(400).send({ error: 'Check the entered values.', issues: error.issues.map((issue) => ({ field: issue.path.join('.'), message: issue.message })) });
    throw error;
  }
}

function draftId(req: FastifyRequest): string { return Uuid.parse((req.params as { id?: string }).id); }

export function registerOperator(app: FastifyInstance, deps: OperatorDeps, tenantOf: TenantOf): void {
  const { db } = deps;
  const mode = deps.integrationMode ?? 'unconfigured';
  app.get('/operator/overview', async (req, reply) => {
    const tenant = tenantOf(req, reply);
    if (!tenant) return;
    const counts = (await db.query(
      `SELECT
        (SELECT count(*)::int FROM automations WHERE tenant_id = $1 AND status = 'active') AS active,
        (SELECT count(*)::int FROM automation_drafts WHERE tenant_id = $1 AND published_revision IS DISTINCT FROM revision) AS drafts,
        (SELECT count(*)::int FROM automation_runs WHERE tenant_id = $1) AS conversations,
        (SELECT count(*)::int FROM leads WHERE tenant_id = $1) AS emails,
        (SELECT count(*)::int FROM automation_runs r WHERE r.tenant_id = $1 AND
          EXISTS (SELECT 1 FROM message_intents i WHERE i.run_id = r.id AND i.status = 'unknown')) AS attention,
        (SELECT count(*)::int FROM social_connections WHERE tenant_id = $1 AND status = 'active' AND verified_at IS NOT NULL) AS accounts`, [tenant],
    )).rows[0];
    const accountStates = (await db.query(`SELECT sc.status, sc.verified_at, sc.sends_paused, sc.capabilities, sc.integration_kind, i.expires_at AS native_expires_at
      FROM social_connections sc LEFT JOIN instagram_credentials i ON i.connection_id = sc.id WHERE sc.tenant_id = $1`, [tenant])).rows;
    return {
      automationsActive: counts.active, drafts: counts.drafts, conversationsStarted: counts.conversations,
      emailsCollected: counts.emails, needsAttention: counts.attention,
      readiness: { dispatchConfigured: deps.dispatchConfigured, accountConnected: accountStates.some((account) => !connectionIssue(account, true, mode, deps.clock.now())),
        canPublish: accountStates.some((account) => !connectionIssue(account, deps.dispatchConfigured, mode, deps.clock.now())), settingsUrl: deps.integrationSettingsUrl ?? null },
    };
  });

  app.get('/operator/accounts', async (req, reply) => {
    const tenant = tenantOf(req, reply);
    if (!tenant) return;
    return listAccounts(deps, tenant);
  });

  app.get('/operator/automations', async (req, reply) => {
    const tenant = tenantOf(req, reply);
    if (!tenant) return;
    const [drafts, automations] = await Promise.all([
      db.query(`SELECT d.*, a.status AS automation_status FROM automation_drafts d LEFT JOIN automations a ON a.id = d.automation_id
                WHERE d.tenant_id = $1 ORDER BY d.updated_at DESC, d.id`, [tenant]),
      db.query(`SELECT a.id, a.name, a.status, a.connection_id, v.version, v.definition,
                 coalesce(sc.display_name, sc.external_account_id) AS connection_name
                FROM automations a JOIN social_connections sc ON sc.id = a.connection_id
                LEFT JOIN automation_versions v ON v.id = a.active_version_id
                WHERE a.tenant_id = $1 AND NOT EXISTS (SELECT 1 FROM automation_drafts d WHERE d.automation_id = a.id)
                ORDER BY a.created_at DESC, a.id`, [tenant]),
    ]);
    return { drafts: drafts.rows.map(draftDto), automations: automations.rows.map((rule) => ({
      id: rule.id, name: rule.name, status: rule.status, connectionId: rule.connection_id,
      version: rule.version, definition: rule.definition, connectionName: rule.connection_name, editable: false,
    })) };
  });

  app.get('/operator/automations/:id', async (req, reply) => respond(reply, async () => {
    const tenant = tenantOf(req, reply);
    if (!tenant) return;
    const row = (await db.query(`SELECT d.*, a.status AS automation_status FROM automation_drafts d LEFT JOIN automations a ON a.id = d.automation_id WHERE d.id = $1 AND d.tenant_id = $2`, [draftId(req), tenant])).rows[0];
    if (row) return { draft: draftDto(row) };
    const rule = (await db.query(
      `SELECT a.id, a.name, a.status, a.connection_id, v.version, v.definition,
        coalesce(sc.display_name, sc.external_account_id) AS connection_name
       FROM automations a JOIN social_connections sc ON sc.id = a.connection_id
       LEFT JOIN automation_versions v ON v.id = a.active_version_id
       WHERE a.id = $1 AND a.tenant_id = $2`, [draftId(req), tenant],
    )).rows[0];
    if (!rule) return reply.code(404).send({ error: 'Automation not found.' });
    return { automation: { id: rule.id, name: rule.name, status: rule.status, definition: rule.definition,
      version: rule.version, connectionId: rule.connection_id, connectionName: rule.connection_name, editable: false } };
  }));

  app.post('/operator/automations', async (req, reply) => respond(reply, async () => {
    const tenant = tenantOf(req, reply);
    if (!tenant) return;
    return reply.code(201).send(await createDraft(deps, tenant, req.body));
  }));

  app.patch('/operator/automations/:id', async (req, reply) => respond(reply, async () => {
    const tenant = tenantOf(req, reply);
    if (!tenant) return;
    return editDraft(deps, tenant, draftId(req), req.body);
  }));

  app.post('/operator/automations/:id/publish', async (req, reply) => respond(reply, async () => {
    const tenant = tenantOf(req, reply);
    if (!tenant) return;
    return publishDraft(deps, tenant, draftId(req), req.body);
  }));

  app.register(async (integration) => {
    integration.addContentTypeParser('application/json', { parseAs: 'buffer', bodyLimit: 16384 }, (_req, bytes, done) => done(null, bytes));
    integration.post('/integrations/accounts', async (req, reply) => respond(reply, async () => {
      if (mode !== 'gateway') return reply.code(503).send({ error: 'Account registration is managed by Instagram Login.' });
      if (!deps.provisioningSecret) return reply.code(503).send({ error: 'Account integration is not configured.' });
      if (!Buffer.isBuffer(req.body) || !validWebhook(req.body, req.headers['x-integration-timestamp'], req.headers['x-integration-signature'], deps.provisioningSecret, deps.clock.now())) {
        return reply.code(401).send({ error: 'Invalid account integration signature.' });
      }
      if (!isUtf8(req.body)) return reply.code(400).send({ error: 'Invalid JSON.' });
      let raw: unknown;
      try { raw = JSON.parse(req.body.toString('utf8')); } catch { return reply.code(400).send({ error: 'Invalid JSON.' }); }
      const event = AccountEvent.parse(raw);
      if (new Date(event.occurredAt).getTime() > deps.clock.now().getTime() + 300_000) return reply.code(400).send({ error: 'Account event timestamp is in the future.' });
      const hash = createHash('sha256').update(req.body).digest('hex');
      return withTx(db, async (c) => {
        if (!(await c.query('SELECT 1 FROM tenants WHERE id = $1', [event.tenantId])).rowCount) throw new OperatorError(404, 'workspace_not_found', 'Workspace not found.');
        const inserted = await c.query(`INSERT INTO integration_account_events (event_id, tenant_id, external_account_id, integration_revision, payload_digest)
          VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING RETURNING event_id`, [event.eventId, event.tenantId, event.accountId, event.integrationRevision, hash]);
        if (!inserted.rowCount) {
          const old = (await c.query('SELECT payload_digest FROM integration_account_events WHERE event_id = $1', [event.eventId])).rows[0];
          if (old.payload_digest !== hash) throw new OperatorError(409, 'event_conflict', 'The integration event ID was already used for different content.');
          return { duplicate: true };
        }
        await c.query(`INSERT INTO social_connections (tenant_id, platform, external_account_id, status) VALUES ($1, 'instagram', $2, 'disconnected') ON CONFLICT (platform, external_account_id) DO NOTHING`,
          [event.tenantId, event.accountId]);
        const account = (await c.query("SELECT id, tenant_id, integration_revision, integration_kind FROM social_connections WHERE platform = 'instagram' AND external_account_id = $1 FOR NO KEY UPDATE", [event.accountId])).rows[0];
        if (account.tenant_id !== event.tenantId) throw new OperatorError(409, 'account_owned_by_other_workspace', 'This account belongs to another workspace.');
        if (account.integration_kind === 'native') throw new OperatorError(409, 'integration_mismatch', 'This account is connected through Instagram Login.');
        if ((await c.query('SELECT 1 FROM instagram_credentials WHERE connection_id = $1', [account.id])).rowCount) throw new OperatorError(409, 'integration_mismatch', 'This account is connected through Instagram Login.');
        if (Number(account.integration_revision) >= event.integrationRevision) return { duplicate: false, stale: true, connectionId: account.id };
        await c.query(`UPDATE social_connections SET display_name = $2, status = $3, capabilities = $4, integration_kind = 'gateway',
          verified_at = CASE WHEN $3 = 'active' THEN now() ELSE NULL END, integration_revision = $5, integration_updated_at = $6,
          sends_paused = CASE WHEN $3 = 'active' AND sends_paused_reason = 'provider_unauthorized' THEN false ELSE sends_paused END,
          sends_paused_reason = CASE WHEN $3 = 'active' AND sends_paused_reason = 'provider_unauthorized' THEN NULL ELSE sends_paused_reason END
          WHERE id = $1`, [account.id, event.displayName, event.status, event.capabilities, event.integrationRevision, event.occurredAt]);
        if (event.status === 'active') await resolveIncident(c, { tenantId: event.tenantId, connectionId: account.id, errorClass: 'connection_unauthorized' });
        return { duplicate: false, stale: false, connectionId: account.id };
      });
    }));
  });
}
