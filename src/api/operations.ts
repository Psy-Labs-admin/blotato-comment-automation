import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { resolveIncident } from '../alerts/incidents';
import { audit } from '../storage/audit';
import { withTx } from '../storage/db';
import { OperatorError } from '../storage/drafts';
import { storableText } from '../storage/text';
import {
  DELIVERY_KINDS,
  DELIVERY_LABELS,
  readPipelineHealth,
  readOperations,
  type DeliveryKind,
  type OperationsConfig,
  type DeliveryConsumer,
} from '../observability/operations';

type TenantOf = (req: FastifyRequest, reply: FastifyReply) => string | undefined;
interface OperationsDeps extends OperationsConfig {
  db: Pool;
  onOutbox?: () => void;
}
const incidentFilter = z.object({
  status: z.enum(['open', 'resolved']).default('open'),
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(25),
});
const bigintId = z
  .string()
  .regex(/^[1-9][0-9]{0,18}$/)
  .refine((v) => v.length <= 19 && /^[0-9]+$/.test(v) && BigInt(v) <= 9223372036854775807n);
const generation = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,18})$/)
  .refine((v) => v.length <= 19 && /^[0-9]+$/.test(v) && BigInt(v) <= 9223372036854775807n);
const deliveryFilter = z.object({
  status: z.enum(['pending', 'dead', 'done']).default('dead'),
  kind: z.enum(DELIVERY_KINDS).optional(),
  cursor: bigintId.optional(),
  limit: z.coerce.number().int().min(1).max(50).default(25),
});
const retryBody = z.object({ expectedGeneration: generation, note: storableText.trim().min(1).max(500) }).strict();
const incidentLabels: Record<string, { title: string; action: string }> = {
  send_outcome_unknown: {
    title: 'Message confirmation missing',
    action: 'Check the conversation in Instagram, then record the confirmed message outcome.',
  },
  connection_unauthorized: {
    title: 'Instagram account needs reconnection',
    action: 'Reconnect the affected account from Accounts.',
  },
  crm_delivery_failing: {
    title: 'CRM delivery needs attention',
    action: 'Check the CRM connection. Retry failed deliveries after the connection is restored.',
  },
  outbox_dead_letter: {
    title: 'Background delivery stopped',
    action: 'Review the failed deliveries and retry recoverable items after fixing the cause.',
  },
};

function incidentDto(row: any) {
  const label = incidentLabels[row.error_class] ?? {
    title: 'Operational incident',
    action: 'Review related deliveries and account settings.',
  };
  return {
    id: row.id,
    type: row.error_class,
    title: label.title,
    status: row.status,
    occurrences: row.occurrences,
    affectedConversations: row.affected_count,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    resolvedAt: row.resolved_at,
    nextAction: label.action,
    runIds: row.run_ids ?? [],
    connectionId: row.connection_id,
  };
}

function deliveryDto(row: any, consumers: DeliveryConsumer[]) {
  const configured = consumers.find((c) => c.kind === row.kind)?.observed ?? false;
  let unavailable: string | null = null;
  if (row.status !== 'dead') unavailable = 'Only stopped deliveries can be retried.';
  else if (!['crm.lead_captured', 'metadata.hydrate'].includes(row.kind))
    unavailable = 'Review the related conversation or notification settings before recovery.';
  else if (!configured) unavailable = 'Start a healthy relay for this destination before retrying.';
  else if (!row.target_exists || (row.kind === 'crm.lead_captured' && row.crm_status === 'synced'))
    unavailable = 'This delivery is already complete or no longer applies.';
  return {
    id: row.id,
    kind: row.kind,
    label: DELIVERY_LABELS[row.kind as DeliveryKind] ?? 'Background delivery',
    status: row.status,
    attempts: row.attempts,
    generation: String(row.retry_generation),
    createdAt: row.created_at,
    nextAttemptAt: row.next_attempt_at,
    finishedAt: row.done_at,
    canRetry: unavailable === null,
    retryUnavailableReason: unavailable,
    incidentId: row.kind === 'alert.notify' && typeof row.incident_id === 'string' ? row.incident_id : null,
  };
}

const incidentProjection = `SELECT i.*,
  ARRAY(SELECT r.id FROM automation_runs r WHERE r.tenant_id=i.tenant_id AND r.id=ANY(i.affected_runs) ORDER BY r.created_at DESC LIMIT 20) AS run_ids,
  (SELECT count(DISTINCT r.conversation_id)::int FROM automation_runs r WHERE r.tenant_id=i.tenant_id AND r.id=ANY(i.affected_runs)) AS affected_count
  FROM incidents i`;
const deliveryProjection = `SELECT o.id::text,o.kind,o.status,o.attempts,o.retry_generation::text,o.created_at,o.next_attempt_at,o.done_at,
  o.payload->>'incidentId' AS incident_id,
  CASE WHEN o.kind='crm.lead_captured' THEN EXISTS(SELECT 1 FROM leads l WHERE l.id::text=o.payload->>'leadId' AND l.tenant_id=o.tenant_id)
       WHEN o.kind='metadata.hydrate' THEN EXISTS(SELECT 1 FROM inbox_events e WHERE e.id::text=o.payload->>'eventId' AND e.tenant_id=o.tenant_id AND e.event_type='comment.created' AND e.media_id IS NOT NULL)
       ELSE false END AS target_exists,
  (SELECT l.crm_status FROM leads l WHERE l.id::text=o.payload->>'leadId' AND l.tenant_id=o.tenant_id) AS crm_status
  FROM outbox o`;

/** Operational API exposes safe facts. Provider payloads and free-form transport errors stay private. */
export function registerOperations(app: FastifyInstance, deps: OperationsDeps, tenantOf: TenantOf): void {
  app.get('/operator/operations', async (req, reply) => {
    const tenant = tenantOf(req, reply);
    if (!tenant) return;
    return readOperations(deps.db, tenant, deps);
  });

  app.get('/operator/incidents', async (req, reply) => {
    const tenant = tenantOf(req, reply);
    if (!tenant) return;
    const parsed = incidentFilter.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid incident filters.' });
    const { status, cursor, limit } = parsed.data;
    const result = await deps.db.query(
      incidentProjection +
        ` WHERE i.tenant_id=$1 AND i.status=$2
       AND ($3::uuid IS NULL OR (i.first_seen_at,i.id)<(SELECT first_seen_at,id FROM incidents WHERE tenant_id=$1 AND id=$3))
       ORDER BY i.first_seen_at DESC,i.id DESC LIMIT $4`,
      [tenant, status, cursor ?? null, limit + 1],
    );
    const rows = result.rows.slice(0, limit);
    return {
      incidents: rows.map(incidentDto),
      nextCursor: result.rows.length > limit ? rows[rows.length - 1].id : null,
    };
  });

  app.get('/operator/incidents/:id', async (req, reply) => {
    const tenant = tenantOf(req, reply);
    if (!tenant) return;
    const id = z
      .string()
      .uuid()
      .safeParse((req.params as { id: string }).id);
    if (!id.success) return reply.code(404).send({ error: 'Incident not found.' });
    const row = (await deps.db.query(incidentProjection + ' WHERE i.id=$1 AND i.tenant_id=$2', [id.data, tenant]))
      .rows[0];
    if (!row) return reply.code(404).send({ error: 'Incident not found.' });
    const history = [{ at: row.first_seen_at, type: 'opened', text: 'The incident was recorded.' }];
    if (row.last_seen_at.getTime() !== row.first_seen_at.getTime())
      history.push({
        at: row.last_seen_at,
        type: 'last_occurrence',
        text: 'The most recent occurrence was recorded.',
      });
    if (row.resolved_at)
      history.push({ at: row.resolved_at, type: 'resolved', text: 'The underlying incident condition cleared.' });
    const deliveries = await deps.db.query(
      deliveryProjection +
        " WHERE o.tenant_id=$1 AND o.kind='alert.notify' AND o.payload->>'incidentId'=$2 ORDER BY o.id DESC LIMIT 25",
      [tenant, id.data],
    );
    const { consumers } = await readPipelineHealth(deps.db, deps);
    return {
      incident: incidentDto(row),
      history,
      deliveries: deliveries.rows.map((delivery) => deliveryDto(delivery, consumers)),
    };
  });

  app.get('/operator/deliveries', async (req, reply) => {
    const tenant = tenantOf(req, reply);
    if (!tenant) return;
    const parsed = deliveryFilter.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid delivery filters.' });
    const { status, kind, cursor, limit } = parsed.data;
    const result = await deps.db.query(
      deliveryProjection +
        ` WHERE o.tenant_id=$1 AND o.status=$2 AND ($3::text IS NULL OR o.kind=$3)
        AND ($4::bigint IS NULL OR o.id<$4) ORDER BY o.id DESC LIMIT $5`,
      [tenant, status, kind ?? null, cursor ?? null, limit + 1],
    );
    const rows = result.rows.slice(0, limit);
    const { consumers } = await readPipelineHealth(deps.db, deps);
    return {
      deliveries: rows.map((row) => deliveryDto(row, consumers)),
      nextCursor: result.rows.length > limit ? rows[rows.length - 1].id : null,
    };
  });

  app.post('/operator/deliveries/:id/retry', async (req, reply) => {
    const tenant = tenantOf(req, reply);
    if (!tenant) return;
    const id = bigintId.safeParse((req.params as { id: string }).id);
    const body = retryBody.safeParse(req.body);
    if (!id.success || !body.success)
      return reply.code(400).send({ error: 'Supply the current delivery revision and a reason for retrying.' });
    const outcome = await withTx(deps.db, async (c) => {
      const row = (
        await c.query('SELECT * FROM outbox WHERE id=$1 AND tenant_id=$2 FOR UPDATE', [id.data, tenant])
      ).rows[0];
      if (!row) throw new OperatorError(404, 'delivery_not_found', 'Delivery not found.');
      const target = (await c.query(deliveryProjection + ' WHERE o.id=$1', [id.data])).rows[0];
      const { consumers } = await readPipelineHealth(c, deps);
      const dto = deliveryDto(target, consumers);
      if (String(row.retry_generation) !== body.data.expectedGeneration || !dto.canRetry) {
        throw new OperatorError(
          409,
          'delivery_changed',
          dto.retryUnavailableReason ?? 'The delivery changed. Reload before retrying.',
        );
      }
      const updated = (
        await c.query(
          `UPDATE outbox SET status='pending',attempts=0,next_attempt_at=now(),done_at=NULL,last_error=NULL,
         locked_until=NULL,claim_token=NULL,retry_generation=retry_generation+1 WHERE id=$1 RETURNING retry_generation::text`,
          [id.data],
        )
      ).rows[0];
      // Serialize tenant-wide dead-letter condition changes after the mutable outbox row.
      await c.query('SELECT id FROM tenants WHERE id=$1 FOR NO KEY UPDATE', [tenant]);
      await audit(c, {
        tenantId: tenant,
        type: 'delivery.retry_requested',
        reason: 'operator',
        data: {
          outboxId: id.data,
          kind: row.kind,
          previousGeneration: String(row.retry_generation),
          generation: updated.retry_generation,
          note: body.data.note,
        },
      });
      const dead = await c.query(
        "SELECT 1 FROM outbox WHERE tenant_id=$1 AND status='dead' AND kind<>'alert.notify' LIMIT 1",
        [tenant],
      );
      if (!dead.rowCount) await resolveIncident(c, { tenantId: tenant, errorClass: 'outbox_dead_letter' });
      return { status: 'pending', generation: updated.retry_generation };
    });
    deps.onOutbox?.();
    return outcome;
  });
}
