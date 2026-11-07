import type { Pool } from 'pg';

export interface TimelineEntry {
  at: string;
  type: string;
  text: string;
  reason?: string;
  refs: Record<string, string>;
}

const KIND_LABEL: Record<string, string> = { comment_reply: 'Public comment reply', private_reply: 'Private reply (DM)', dm: 'DM' };

/**
 * "Why did this run stop?" — every line is a recorded fact (inbox, audit, ledger), never a guess.
 * "Delivered" never appears: the platform only tells us it *accepted* a message.
 */
export async function buildTimeline(db: Pool, tenantId: string, runId: string): Promise<TimelineEntry[] | null> {
  const run = (
    await db.query(
      `SELECT r.*, e.received_at AS trigger_at, e.media_id, e.comment_id, v.version, v.definition
         FROM automation_runs r JOIN inbox_events e ON e.id = r.trigger_event_id JOIN automation_versions v ON v.id = r.version_id
        WHERE r.id = $1 AND r.tenant_id = $2`,
      [runId, tenantId],
    )
  ).rows[0];
  if (!run) return null;

  const entries: TimelineEntry[] = [
    {
      at: run.trigger_at.toISOString(),
      type: 'comment.received',
      text: `Comment received on post ${run.media_id}`,
      refs: { commentId: run.comment_id, mediaId: run.media_id },
    },
  ];
  const intents = new Map<string, any>(
    (await db.query(`SELECT id, step_id, action_no, kind FROM message_intents WHERE run_id = $1`, [runId])).rows.map((i) => [i.id, i]),
  );
  const audit = await db.query(`SELECT * FROM run_audit_events WHERE run_id = $1 ORDER BY id`, [runId]);
  for (const a of audit.rows) {
    const intent = a.intent_id ? intents.get(a.intent_id) : undefined;
    const label = intent ? `${KIND_LABEL[intent.kind] ?? intent.kind} (${intent.step_id}${intent.action_no > 1 ? ` #${intent.action_no}` : ''})` : '';
    const text = describe(a, label, run);
    if (!text) continue;
    entries.push({
      at: a.created_at.toISOString(),
      type: a.type,
      text,
      reason: a.reason ?? undefined,
      refs: Object.fromEntries(
        Object.entries({ intentId: a.intent_id, eventId: a.inbox_event_id }).filter(([, v]) => v) as [string, string][],
      ),
    });
  }

  const lead = (await db.query(`SELECT crm_status FROM leads WHERE run_id = $1`, [runId])).rows[0];
  if (lead && lead.crm_status !== 'synced') {
    entries.push({
      at: new Date().toISOString(),
      type: 'crm.pending',
      text: lead.crm_status === 'failed' ? 'CRM: delivery failed, kept for redelivery' : 'CRM: waiting for retry',
      refs: {},
    });
  }
  return entries;
}

function describe(a: any, label: string, run: any): string | null {
  const d = a.data ?? {};
  switch (a.type) {
    case 'run.created':
      return `Rule "${run.definition.trigger.keyword}" matched; published version ${d.version ?? run.version} started`;
    case 'send.attempt_started':
      return `${label}: attempt ${d.attemptNo} sent to Instagram`;
    case 'send.accepted':
      return `${label}: accepted by Instagram`;
    case 'send.deferred':
      return `${label}: deferred (${a.reason}), will retry`;
    case 'send.unknown':
      return `${label}: outcome UNKNOWN (${a.reason}${d.providerCode ? `: ${d.providerCode}` : ''}) — conversation held, no automatic resend`;
    case 'send.resolved':
      return `${label}: outcome resolved as ${d.resolution ?? 'accepted'} (${a.reason})`;
    case 'send.blocked':
      return `${label}: blocked by policy (${a.reason})`;
    case 'send.cancelled':
      return `${label}: not sent, run cancelled (${a.reason})`;
    case 'send.rejected':
      return `${label}: rejected by Instagram (${a.reason})`;
    case 'wait.active':
      return `Question accepted; waiting for an email until ${d.deadline ? new Date(d.deadline).toISOString() : 'deadline'}`;
    case 'input.accepted':
      return 'Reply received; email passed the format check (not verified)';
    case 'input.rejected':
      return `Reply received; not a usable email (${a.reason})`;
    case 'input.clarification_requested':
      return 'Asking once more for the email';
    case 'wait.expired':
      return 'No valid reply before the deadline';
    case 'wait.cancelled':
      return `Waiting stopped (${a.reason})`;
    case 'run.cancel_requested':
      return `Cancel requested (${a.reason})`;
    case 'run.status':
      return d.status === 'blocked_unknown' ? 'Run paused until the uncertain send is resolved' : null;
    case 'crm.synced':
      return 'CRM: lead synced';
    case 'conversation.held':
      return 'Conversation stays held: a send outcome is unresolved';
    case 'conversation.released':
      return 'Conversation released';
    case 'run.finished':
      return `Run finished: ${d.outcome}${a.reason && a.reason !== d.outcome ? ` (${a.reason})` : ''}`;
    default:
      return null;
  }
}

/** Conversation-level view: every inbound event with its routing outcome, plus decisions. */
export async function buildConversationTimeline(db: Pool, tenantId: string, conversationId: string) {
  const conv = (await db.query(`SELECT id FROM conversations WHERE id = $1 AND tenant_id = $2`, [conversationId, tenantId])).rows[0];
  if (!conv) return null;
  const events = await db.query(
    `SELECT id, event_type, seq, received_at, routing_outcome, run_id FROM inbox_events WHERE conversation_id = $1 ORDER BY seq`,
    [conversationId],
  );
  const audit = await db.query(`SELECT type, reason, run_id, created_at FROM run_audit_events WHERE conversation_id = $1 ORDER BY id`, [conversationId]);
  return {
    inbound: events.rows.map((e) => ({ at: e.received_at, type: e.event_type, seq: Number(e.seq), outcome: e.routing_outcome, runId: e.run_id })),
    decisions: audit.rows,
  };
}
