import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { DefinitionError } from '../domain/definition';
import { OperatorError, draftDto } from '../storage/drafts';
import { setAutomationStatus } from '../storage/admin';
import { buildTimeline } from '../timeline';
import { createDraft, editDraft, publishDraft, listAccounts, type DraftDeps } from './draft-actions';
import { registerIntegrationAuth } from './integration-keys';

const Uuid = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());
const Page = z
  .object({ limit: z.coerce.number().int().min(1).max(100).default(25), cursor: Uuid.optional() })
  .strict();
const RunsPage = Page.extend({
  status: z
    .enum([
      'starting',
      'running',
      'waiting_input',
      'blocked_unknown',
      'completed',
      'cancelled',
      'failed',
      'expired',
    ])
    .optional(),
  needsReview: z.enum(['true', 'false']).optional(),
});
const Empty = z.object({}).strict();
const idOf = (req: FastifyRequest) => Uuid.parse((req.params as { id: string }).id);
const automationDto = (r: any) => ({
  id: r.id,
  name: r.name,
  connectionId: r.connection_id,
  status: r.status,
  versionId: r.active_version_id,
  version: r.version,
});
const runDto = (r: any) => ({
  id: r.id,
  automationId: r.automation_id,
  conversationId: r.conversation_id,
  status: r.status,
  statusReason: r.status_reason,
  currentStep: r.current_step,
  createdAt: r.created_at,
  finishedAt: r.finished_at,
});
const leadDto = (r: any) => ({
  id: r.id,
  email: r.email,
  runId: r.run_id,
  conversationId: r.conversation_id,
  createdAt: r.created_at,
  crmStatus: r.crm_status,
});

/** Supported integration API. Register under /api/v1; auth is encapsulated in this plugin. */
export async function registerPublicApi(app: FastifyInstance, deps: DraftDeps): Promise<void> {
  const { db } = deps;
  const identity = registerIntegrationAuth(app, db);
  const tenantOf = (req: FastifyRequest) => identity(req).tenantId;
  app.setErrorHandler((error, req, reply) => {
    if (error instanceof OperatorError)
      return reply.code(error.status).send({ error: error.message, code: error.code });
    if (error instanceof z.ZodError)
      return reply.code(400).send({ error: 'Invalid request.', code: 'invalid_request' });
    if (error instanceof DefinitionError)
      return reply
        .code(400)
        .send({ error: 'Complete the automation before publishing.', code: 'invalid_definition' });
    const status = (error as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) return reply.code(status).send({ error: 'Invalid request.' });
    req.log.error({ err: error }, 'Integration request failed');
    return reply.code(500).send({ error: 'Request could not be completed.' });
  });
  app.addHook('preValidation', async (req) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') Empty.parse(req.query);
  });
  // The allowlisted table name is internal; tuple comparisons below preserve PostgreSQL microseconds.
  // Cursors are resolved inside the authenticated tenant.
  async function validateCursor(
    table: 'automation_drafts' | 'automations' | 'automation_runs' | 'leads',
    tenant: string,
    cursor?: string,
  ): Promise<void> {
    if (!cursor) return;
    const row = (await db.query(`SELECT 1 FROM ${table} WHERE id = $1 AND tenant_id = $2`, [cursor, tenant]))
      .rows[0];
    if (!row) throw new OperatorError(400, 'invalid_cursor', 'Invalid cursor.');
  }
  function page(rows: any[], limit: number, map: (row: any) => unknown, key: string) {
    const selected = rows.slice(0, limit);
    return { [key]: selected.map(map), nextCursor: rows.length > limit ? selected[selected.length - 1].id : null };
  }
  app.get('/workspace', async (req) => {
    Empty.parse(req.query);
    const row = (await db.query('SELECT id, name FROM tenants WHERE id = $1', [tenantOf(req)])).rows[0];
    if (!row) throw new OperatorError(404, 'workspace_not_found', 'Workspace not found.');
    return row;
  });
  app.get('/accounts', async (req) => {
    Empty.parse(req.query);
    return listAccounts(deps, tenantOf(req));
  });
  app.get('/drafts', async (req) => {
    const { limit, cursor } = Page.parse(req.query);
    const tenant = tenantOf(req);
    await validateCursor('automation_drafts', tenant, cursor);
    const rows = (
      await db.query(
        `SELECT d.*, a.status AS automation_status FROM automation_drafts d
      LEFT JOIN automations a ON a.id = d.automation_id AND a.tenant_id = d.tenant_id
      WHERE d.tenant_id = $1 AND ($2::uuid IS NULL OR (d.created_at, d.id) <
        (SELECT created_at, id FROM automation_drafts WHERE id = $2 AND tenant_id = $1))
      ORDER BY d.created_at DESC, d.id DESC LIMIT $3`,
        [tenant, cursor ?? null, limit + 1],
      )
    ).rows;
    return page(rows, limit, draftDto, 'drafts');
  });
  app.post('/drafts', async (req, reply) => {
    const key = req.headers['idempotency-key'];
    const count = req.raw.rawHeaders.filter(
      (value, index) => index % 2 === 0 && value.toLowerCase() === 'idempotency-key',
    ).length;
    if (key !== undefined && (typeof key !== 'string' || count > 1 || !/^[A-Za-z0-9._:-]{1,128}$/.test(key)))
      throw new OperatorError(400, 'invalid_request', 'Idempotency-Key must be one 1–128 character token using letters, digits, dot, underscore, colon or hyphen.');
    return reply.code(201).send(await createDraft(deps, tenantOf(req), req.body, key as string | undefined));
  });
  app.get('/drafts/:id', async (req) => {
    Empty.parse(req.query);
    const row = (
      await db.query(
        `SELECT d.*, a.status AS automation_status FROM automation_drafts d
      LEFT JOIN automations a ON a.id = d.automation_id AND a.tenant_id = d.tenant_id WHERE d.id = $1 AND d.tenant_id = $2`,
        [idOf(req), tenantOf(req)],
      )
    ).rows[0];
    if (!row) throw new OperatorError(404, 'draft_not_found', 'Automation not found.');
    return { draft: draftDto(row) };
  });
  app.patch('/drafts/:id', async (req) => editDraft(deps, tenantOf(req), idOf(req), req.body));
  app.post('/drafts/:id/publish', async (req) => publishDraft(deps, tenantOf(req), idOf(req), req.body));
  app.get('/automations', async (req) => {
    const { limit, cursor } = Page.parse(req.query);
    const tenant = tenantOf(req);
    await validateCursor('automations', tenant, cursor);
    const rows = (
      await db.query(
        `SELECT a.id, a.name, a.connection_id, a.status, a.active_version_id, v.version
      FROM automations a JOIN automation_versions v ON v.id = a.active_version_id AND v.tenant_id = a.tenant_id
      WHERE a.tenant_id = $1 AND ($2::uuid IS NULL OR (a.created_at, a.id) <
        (SELECT created_at, id FROM automations WHERE id = $2 AND tenant_id = $1))
      ORDER BY a.created_at DESC, a.id DESC LIMIT $3`,
        [tenant, cursor ?? null, limit + 1],
      )
    ).rows;
    return page(rows, limit, automationDto, 'automations');
  });
  app.get('/automations/:id', async (req) => {
    Empty.parse(req.query);
    const row = (
      await db.query(
        `SELECT a.id, a.name, a.connection_id, a.status, a.active_version_id, v.version
      FROM automations a JOIN automation_versions v ON v.id = a.active_version_id AND v.tenant_id = a.tenant_id
      WHERE a.id = $1 AND a.tenant_id = $2`,
        [idOf(req), tenantOf(req)],
      )
    ).rows[0];
    if (!row) throw new OperatorError(404, 'automation_not_found', 'Automation not found.');
    return { automation: automationDto(row) };
  });
  for (const [action, status] of [
    ['enable', 'active'],
    ['disable', 'disabled'],
  ] as const) {
    app.post(`/automations/:id/${action}`, async (req) => {
      Empty.parse(req.body ?? {});
      const tenantId = tenantOf(req);
      const automationId = idOf(req);
      if (
        !(
          await db.query(
            'SELECT 1 FROM automations WHERE id = $1 AND tenant_id = $2 AND active_version_id IS NOT NULL',
            [automationId, tenantId],
          )
        ).rowCount ||
        !(await setAutomationStatus(db, { ...deps, tenantId, automationId, status }))
      )
        throw new OperatorError(404, 'automation_not_found', 'Automation not found.');
      return { status };
    });
  }
  app.get('/runs', async (req) => {
    const { limit, cursor, status, needsReview } = RunsPage.parse(req.query);
    const tenant = tenantOf(req);
    await validateCursor('automation_runs', tenant, cursor);
    const rows = (
      await db.query(
        `SELECT r.id, r.automation_id, r.conversation_id, r.status, r.status_reason, r.current_step, r.created_at, r.finished_at
      FROM automation_runs r WHERE r.tenant_id = $1 AND ($2::text IS NULL OR r.status = $2)
      AND ($3::boolean IS NULL OR EXISTS (SELECT 1 FROM message_intents i WHERE i.run_id = r.id AND i.tenant_id = r.tenant_id AND i.status = 'unknown') = $3)
      AND ($4::uuid IS NULL OR (r.created_at, r.id) < (SELECT created_at, id FROM automation_runs WHERE id = $4 AND tenant_id = $1))
      ORDER BY r.created_at DESC, r.id DESC LIMIT $5`,
        [
          tenant,
          status ?? null,
          needsReview === undefined ? null : needsReview === 'true',
          cursor ?? null,
          limit + 1,
        ],
      )
    ).rows;
    return page(rows, limit, runDto, 'runs');
  });
  app.get('/runs/:id', async (req) => {
    Empty.parse(req.query);
    const row = (
      await db.query(
        `SELECT id, automation_id, conversation_id, status, status_reason, current_step, created_at, finished_at
      FROM automation_runs WHERE id = $1 AND tenant_id = $2`,
        [idOf(req), tenantOf(req)],
      )
    ).rows[0];
    if (!row) throw new OperatorError(404, 'run_not_found', 'Run not found.');
    return { run: runDto(row) };
  });
  app.get('/runs/:id/timeline', async (req) => {
    Empty.parse(req.query);
    const entries = await buildTimeline(db, tenantOf(req), idOf(req));
    if (!entries) throw new OperatorError(404, 'run_not_found', 'Run not found.');
    return { entries };
  });
  app.get('/leads', async (req) => {
    const { limit, cursor } = Page.parse(req.query);
    const tenant = tenantOf(req);
    await validateCursor('leads', tenant, cursor);
    const rows = (
      await db.query(
        `SELECT id, email, run_id, conversation_id, created_at, crm_status FROM leads
      WHERE tenant_id = $1 AND ($2::uuid IS NULL OR (created_at, id) < (SELECT created_at, id FROM leads WHERE id = $2 AND tenant_id = $1))
      ORDER BY created_at DESC, id DESC LIMIT $3`,
        [tenant, cursor ?? null, limit + 1],
      )
    ).rows;
    return page(rows, limit, leadDto, 'leads');
  });
}
