/**
 * Drives the running stack (npm run dev) over HTTP and prints what happened, scenario by scenario:
 *   1. happy path            2. duplicate webhooks          3. lost acknowledgement + operator
 *   4. CRM outage            5. business funnel
 * Requires: the app on :3000 with FAKES=1 (fake Instagram :4001, fake CRM :4002, alert sink :4003).
 */
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../src/config';
import { createPool } from '../src/storage/db';
import { seed, type DemoIds } from './seed';

const API = process.env.API_URL ?? 'http://localhost:3000';
const IG = process.env.INSTAGRAM_BASE_URL ?? 'http://localhost:4001';
const CRM = process.env.CRM_BASE_URL ?? 'http://localhost:4002';
const SINK = process.env.ALERT_SINK_URL ?? 'http://localhost:4003';

const c = { dim: '\x1b[2m', bold: '\x1b[1m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m', reset: '\x1b[0m' };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let ids: DemoIds;

async function http(method: string, url: string, body?: unknown, tenant = true): Promise<any> {
  const res = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json', ...(tenant ? { 'x-tenant-id': ids.tenantId } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return text ? JSON.parse(text) : undefined;
}

const comment = (from: string, commentId = `c_${randomUUID().slice(0, 8)}`) => ({
  type: 'comment.created', accountId: ids.accountId, commentId, mediaId: 'post_spring_menu',
  from: { id: from, username: from }, text: 'Love this! pricing?', occurredAt: new Date().toISOString(),
});
const dm = (from: string, text: string) => ({
  type: 'message.received', accountId: ids.accountId, messageId: `m_${randomUUID().slice(0, 8)}`, from: { id: from }, text, occurredAt: new Date().toISOString(),
});

async function runOf(eventId: string): Promise<string> {
  for (let i = 0; i < 100; i++) {
    const ev = await http('GET', `${API}/events/${eventId}`);
    if (ev?.runId) return ev.runId;
    await sleep(100);
  }
  throw new Error('no run for event');
}
async function waitStatus(runId: string, statuses: string[], timeoutMs = 20_000): Promise<any> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const r = await http('GET', `${API}/runs/${runId}`);
    if (statuses.includes(r.run.status)) return r;
    if (Date.now() > until) throw new Error(`run ${runId} stuck in ${r.run.status}`);
    await sleep(150);
  }
}
async function printTimeline(runId: string) {
  const t = await http('GET', `${API}/runs/${runId}/timeline`);
  for (const e of t.entries) console.log(`   ${c.dim}${e.at.slice(11, 23)}${c.reset}  ${e.text}`);
}
const sentTo = async (participant: string) => ((await http('GET', `${IG}/__control/sent`, undefined, false)) as any[]).filter((m) => m.recipientId === participant);
const header = (n: number, title: string) => console.log(`\n${c.bold}${c.cyan}${n}. ${title}${c.reset}`);
const ok = (msg: string) => console.log(`   ${c.green}✔${c.reset} ${msg}`);

async function happyPath() {
  header(1, 'Happy path: comment → public reply → DM question → email → DM with link');
  const who = `alice_${Date.now() % 100000}`;
  const ack = await http('POST', `${API}/webhooks/instagram`, comment(who), false);
  const runId = await runOf(ack.eventId);
  await waitStatus(runId, ['waiting_input']);
  ok('question accepted by Instagram; waiting for an email');
  await http('POST', `${API}/webhooks/instagram`, dm(who, `sure, it's ${who}@example.com`), false);
  const r = await waitStatus(runId, ['completed']);
  ok(`run completed; lead ${r.lead.email} (${r.lead.email_status})`);
  await sleep(500);
  await printTimeline(runId);
}

async function duplicates() {
  header(2, 'The same comment webhook delivered 3 times');
  const who = `bob_${Date.now() % 100000}`;
  const ev = comment(who);
  const acks = await Promise.all([1, 2, 3].map(() => http('POST', `${API}/webhooks/instagram`, ev, false)));
  console.log(`   acks: ${acks.map((a) => (a.duplicate ? 'duplicate' : 'accepted')).join(', ')}`);
  const runId = await runOf(acks[0].eventId);
  await waitStatus(runId, ['waiting_input']);
  const replies = ((await http('GET', `${IG}/__control/sent`, undefined, false)) as any[]).filter((m) => m.commentId === ev.commentId);
  ok(`one run, ${replies.length} messages for that comment (public reply + private reply), no duplicates`);
  await http('POST', `${API}/runs/${runId}/cancel`, { reason: 'demo cleanup' });
}

async function lostAck() {
  header(3, 'Instagram accepts the link DM but the acknowledgement is lost');
  const who = `carol_${Date.now() % 100000}`;
  await http('POST', `${IG}/__control/faults`, { mode: 'accept_then_drop', kind: 'dm', textIncludes: 'pricing' }, false);
  const ack = await http('POST', `${API}/webhooks/instagram`, comment(who), false);
  const runId = await runOf(ack.eventId);
  await waitStatus(runId, ['waiting_input']);
  await http('POST', `${API}/webhooks/instagram`, dm(who, `${who}@example.com`), false);
  const r = await waitStatus(runId, ['blocked_unknown']);
  const link = r.intents.find((i: any) => i.step_id === 'send_link');
  ok(`run is blocked_unknown; intent ${link.id.slice(0, 8)} status=${link.status}; conversation held; nothing re-sent`);
  console.log(`   ${c.yellow}alert sink received:${c.reset}`);
  let alert: string | undefined;
  for (let i = 0; i < 50 && !alert; i++) {
    const alerts: string[] = await http('GET', `${SINK}/alerts`, undefined, false);
    alert = alerts.filter((a) => a.includes('unknown outcome') && !a.startsWith('[RESOLVED]')).at(-1);
    if (!alert) await sleep(100);
  }
  for (const line of (alert ?? '(none yet)').split('\n')) console.log(`     ${c.dim}${line}${c.reset}`);
  console.log(`   operator checks the Instagram inbox and confirms the DM is there:`);
  await http('POST', `${API}/intents/${link.id}/resolve`, { resolution: 'accepted', note: 'visible in Instagram inbox' });
  await waitStatus(runId, ['completed']);
  ok(`run completed; DMs Instagram stored for ${who}: ${(await sentTo(who)).length} (no duplicate)`);
  await printTimeline(runId);
}

async function crmOutage() {
  header(4, 'CRM is down while a lead is captured');
  const who = `dan_${Date.now() % 100000}`;
  await http('POST', `${CRM}/__control/down`, { down: true }, false);
  const ack = await http('POST', `${API}/webhooks/instagram`, comment(who), false);
  const runId = await runOf(ack.eventId);
  await waitStatus(runId, ['waiting_input']);
  await http('POST', `${API}/webhooks/instagram`, dm(who, `${who}@example.com`), false);
  let r = await waitStatus(runId, ['completed']);
  ok(`the person got the link anyway; lead crm_status=${r.lead.crm_status}`);
  await sleep(1500);
  await http('POST', `${CRM}/__control/down`, { down: false }, false);
  for (let i = 0; i < 100 && r.lead.crm_status !== 'synced'; i++) {
    await sleep(300);
    r = await http('GET', `${API}/runs/${runId}`);
  }
  ok(`CRM back: lead crm_status=${r.lead.crm_status}`);
}

async function funnel() {
  header(5, 'Funnel (run cohort, from Postgres facts)');
  console.log(JSON.stringify(await http('GET', `${API}/funnel`), null, 2).replace(/^/gm, '   '));
}

async function main() {
  const db = createPool(loadConfig().databaseUrl, 2);
  ids = await seed(db);
  await db.end();
  console.log(`${c.dim}tenant ${ids.tenantId} · account ${ids.accountId}${c.reset}`);
  await happyPath();
  await duplicates();
  await lostAck();
  await crmOutage();
  await funnel();
  console.log(`\n${c.dim}Temporal UI: http://localhost:8233 · metrics: ${API}/metrics${c.reset}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
