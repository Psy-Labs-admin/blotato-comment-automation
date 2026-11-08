import { performance } from 'node:perf_hooks';
import { writeFileSync } from 'node:fs';
import { createLoadStack } from './load-stack';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function percentile(values: number[], quantile: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return Number(sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)].toFixed(2));
}

function integer(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const value = Number(env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

interface Delivery {
  type: 'comment.created' | 'message.received';
  accountId: string;
  commentId?: string;
  messageId?: string;
  mediaId?: string;
  from: { id: string };
  text: string;
  occurredAt: string;
}

/** Exactly every fifth request redelivers the preceding event. Both phases use this pattern. */
function deliveries(accountId: string, count: number, type: Delivery['type']): Delivery[] {
  const result: Delivery[] = [];
  let unique = 0;
  for (let index = 0; index < count; index++) {
    if (index % 5 === 4) {
      result.push(result[index - 1]);
      continue;
    }
    const participant = `load_user_${unique++}`;
    result.push({
      type, accountId, from: { id: participant }, occurredAt: new Date().toISOString(),
      ...(type === 'comment.created' ? { commentId: `comment_${participant}`, mediaId: 'load_post', text: 'pricing' } : { messageId: `message_${participant}`, text: `${participant}@example.com` }),
    });
  }
  return result;
}

async function deliverAtRate(url: string, events: Delivery[], rate: number, sign: (raw: string) => Record<string, string>) {
  const httpMs: number[] = [];
  const scheduledMs: number[] = [];
  const scheduleLagMs: number[] = [];
  let accepted = 0;
  let duplicates = 0;
  let errors = 0;
  const start = performance.now();
  let lastDispatch = start;
  const pending: Promise<void>[] = [];
  for (const [index, event] of events.entries()) {
    const scheduled = start + index * 1000 / rate;
    const wait = scheduled - performance.now();
    if (wait > 0) await sleep(wait);
    const dispatched = performance.now();
    lastDispatch = dispatched;
    scheduleLagMs.push(dispatched - scheduled);
    pending.push((async () => {
      try {
        const raw = JSON.stringify(event);
        const response = await fetch(`${url}/webhooks/instagram`, { method: 'POST', headers: sign(raw), body: raw, signal: AbortSignal.timeout(30_000), redirect: 'error' });
        const body = await response.json() as { duplicate?: boolean; eventId?: string };
        const finished = performance.now();
        httpMs.push(finished - dispatched);
        scheduledMs.push(finished - scheduled);
        if (response.status !== 202 || !body.eventId) { errors++; return; }
        accepted++;
        if (body.duplicate) duplicates++;
      } catch { errors++; }
    })());
  }
  await Promise.all(pending);
  return {
    attempted: events.length, accepted, duplicates, errors,
    targetDeliveriesPerSecond: rate,
    dispatchDeliveriesPerSecond: Number(((events.length - 1) * 1000 / Math.max(1, lastDispatch - start)).toFixed(2)),
    httpAcknowledgementP50Ms: percentile(httpMs, 0.5), httpAcknowledgementP95Ms: percentile(httpMs, 0.95),
    scheduledToAcknowledgementP95Ms: percentile(scheduledMs, 0.95), generatorScheduleLagP95Ms: percentile(scheduleLagMs, 0.95),
    elapsedMs: Number((performance.now() - start).toFixed(2)),
  };
}

async function waitUntil(check: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const end = performance.now() + timeoutMs;
  do {
    if (await check()) return true;
    await sleep(100);
  } while (performance.now() < end);
  return false;
}

export async function runLoadCheck(env: NodeJS.ProcessEnv = process.env) {
  const rate = integer(env, 'LOAD_RATE', 100);
  const count = integer(env, 'LOAD_DELIVERIES', 1000);
  const timeoutMs = integer(env, 'LOAD_DRAIN_TIMEOUT_MS', 120_000);
  const unique = count - Math.floor(count / 5);
  const stack = await createLoadStack(count);
  try {
    const comments = await deliverAtRate(stack.url, deliveries(stack.accountId, count, 'comment.created'), rate, stack.auth.webhookHeaders);
    const promptsReady = await waitUntil(async () => Number((await stack.db.query(`SELECT count(*) AS n FROM input_waits WHERE status = 'active'`)).rows[0].n) === unique, timeoutMs);
    const messages = await deliverAtRate(stack.url, deliveries(stack.accountId, count, 'message.received'), rate, stack.auth.webhookHeaders);
    const drained = await waitUntil(async () => {
      const progress = (await stack.db.query(`SELECT (SELECT count(*)::int FROM automation_runs WHERE status = 'completed') AS completed, (SELECT count(*)::int FROM outbox WHERE status <> 'done') AS pending`)).rows[0];
      return progress.completed === unique && progress.pending === 0 && stack.crm.records().length === unique;
    }, timeoutMs);
    const facts = (await stack.db.query(
      `SELECT
         (SELECT count(*)::int FROM inbox_events) AS inbox,
         (SELECT count(*)::int FROM inbox_events WHERE routing_status = 'routed') AS routed,
         (SELECT count(*)::int FROM automation_runs) AS runs,
         (SELECT count(*)::int FROM automation_runs WHERE status = 'completed') AS completed,
         (SELECT count(*)::int FROM automation_runs WHERE finished_at IS NOT NULL AND status <> 'completed') AS failed,
         (SELECT count(*)::int FROM leads) AS leads,
         (SELECT count(*)::int FROM message_intents WHERE status = 'accepted') AS sends,
         (SELECT count(*)::int FROM outbox WHERE status <> 'done') AS pending_outbox`,
    )).rows[0];
    const latencies = (await stack.db.query(
      `SELECT extract(epoch FROM (r.finished_at - e.received_at)) * 1000 AS ms
         FROM automation_runs r JOIN input_waits w ON w.run_id = r.id
         JOIN inbox_events e ON e.id = w.consumed_event_id WHERE r.status = 'completed'`,
    )).rows.map((row) => Number(row.ms));
    const expectedDuplicates = count - unique;
    const expectedInbox = unique * 2;
    const actualSends = stack.ig.sent().length;
    const loss = expectedInbox - facts.inbox;
    const passed = promptsReady && drained && comments.errors === 0 && messages.errors === 0 && comments.duplicates === expectedDuplicates && messages.duplicates === expectedDuplicates && loss === 0 && facts.routed === expectedInbox && facts.runs === unique && facts.completed === unique && facts.failed === 0 && facts.leads === unique && facts.sends === unique * 3 && actualSends === unique * 3 && stack.crm.records().length === unique && facts.pending_outbox === 0;
    return {
      passed, environment: { node: process.version, process: 'single Node process, isolated PostgreSQL database, ephemeral Temporal dev server, HTTP fakes', businessLimits: 'account budget raised for this isolated run' },
      comments, messages, expectedUniqueConversations: unique, expectedUniqueInboxEvents: expectedInbox,
      persistedUniqueInboxEvents: facts.inbox, routedUniqueInboxEvents: facts.routed, loss,
      runsStarted: facts.runs, runsCompleted: facts.completed, runsFailed: facts.failed, unfinishedRuns: facts.runs - facts.completed - facts.failed,
      leads: facts.leads, crmRecords: stack.crm.records().length, acceptedSendIntents: facts.sends, actualProviderSends: actualSends, pendingOutbox: facts.pending_outbox,
      emailReceiptToRunCompletionP50Ms: percentile(latencies, 0.5), emailReceiptToRunCompletionP95Ms: percentile(latencies, 0.95), promptsReady, drained,
    };
  } finally { await stack.close(); }
}

if (require.main === module) {
  runLoadCheck().then((report) => {
    const json = JSON.stringify(report, null, 2);
    if (process.env.LOAD_REPORT_PATH) writeFileSync(process.env.LOAD_REPORT_PATH, json + '\n');
    console.log(json);
    if (!report.passed) process.exitCode = 1;
  }).catch((err) => { console.error(err); process.exitCode = 1; });
}
