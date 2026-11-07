import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { HttpInstagramAdapter } from '../../src/adapters/instagram';
import { HttpCrmClient } from '../../src/adapters/crm';
import { HttpAlertSink } from '../../src/adapters/alerts';
import { startFakeInstagram, type FakeInstagram } from '../../src/fakes/fake-instagram';
import { startFakeCrm, type FakeCrm } from '../../src/fakes/fake-crm';
import { startFakeAlertSink, type FakeAlertSink } from '../../src/fakes/fake-alert-sink';

describe('Instagram adapter against the fault-injecting fake', () => {
  let ig: FakeInstagram;
  let adapter: HttpInstagramAdapter;
  const dm = (clientRef: string) =>
    adapter.send({ kind: 'dm', accountId: 'ig_1', recipientId: 'user_1', text: 'hello', clientRef });

  beforeAll(async () => {
    ig = await startFakeInstagram();
    adapter = new HttpInstagramAdapter(ig.url, { timeoutMs: 500 });
  });
  afterAll(async () => ig.close());
  beforeEach(() => ig.reset());

  it('classifies a 2xx as accepted with the provider message id', async () => {
    const out = await dm('r1');
    expect(out).toMatchObject({ status: 'accepted', httpStatus: 200 });
    expect(out.status === 'accepted' && out.providerMessageId).toMatch(/^mid_/);
    expect(ig.sent()).toHaveLength(1);
  });

  it('classifies a permanent provider error as rejected and records nothing', async () => {
    ig.pushFault({ mode: 'reject_permanent' });
    expect(await dm('r2')).toMatchObject({ status: 'rejected', code: '551' });
    expect(ig.sent()).toHaveLength(0);
  });

  it('classifies an auth failure as rejected/unauthorized', async () => {
    ig.pushFault({ mode: 'unauthorized' });
    expect(await dm('r3')).toMatchObject({ status: 'rejected', code: 'unauthorized', httpStatus: 401 });
  });

  it('a per-message permission error (code 10) is a rejection, not an account auth failure (review finding)', async () => {
    ig.pushFault({ mode: 'error', httpStatus: 400, code: 10 });
    expect(await dm('r10')).toMatchObject({ status: 'rejected', code: '10' });
  });

  it('Graph API throttling codes on HTTP 400 mean not processed (review finding)', async () => {
    ig.pushFault({ mode: 'error', httpStatus: 400, code: 613 });
    expect((await dm('r11')).status).toBe('not_sent');
  });

  it('classifies throttling as not_sent with a retry hint', async () => {
    ig.pushFault({ mode: 'rate_limit' });
    const out = await dm('r4');
    expect(out.status).toBe('not_sent');
    expect(out.status === 'not_sent' && out.retryAfterMs).toBeGreaterThan(0);
  });

  it('accept_then_drop: the provider stored the message but we only see a broken connection -> unknown', async () => {
    ig.pushFault({ mode: 'accept_then_drop' });
    expect(await dm('r5')).toMatchObject({ status: 'unknown' });
    expect(ig.sent()).toHaveLength(1);
  });

  it('a response slower than the adapter timeout is unknown, not failed', async () => {
    ig.pushFault({ mode: 'delay', delayMs: 1_000 });
    expect(await dm('r6')).toMatchObject({ status: 'unknown', code: 'timeout' });
    expect(ig.sent()).toHaveLength(1);
  });

  it('an ambiguous 5xx is unknown', async () => {
    ig.pushFault({ mode: 'accept_then_500' });
    expect(await dm('r7')).toMatchObject({ status: 'unknown' });
  });

  it('a refused connection is definitely not sent', async () => {
    const probe = await startFakeAlertSink();
    const closedUrl = probe.url;
    await probe.close(); // the port is now closed: connections are refused
    const dead = new HttpInstagramAdapter(closedUrl, { timeoutMs: 500 });
    const out = await dead.send({ kind: 'dm', accountId: 'ig_1', recipientId: 'u', text: 't', clientRef: 'r8' });
    expect(out.status).toBe('not_sent');
  });

  it('lookupByClientRef finds a message whose response was lost', async () => {
    ig.pushFault({ mode: 'accept_then_drop' });
    await dm('r9');
    const found = await adapter.lookupByClientRef('ig_1', 'r9');
    expect(found).toMatchObject({ found: true });
    expect(await adapter.lookupByClientRef('ig_1', 'nope')).toEqual({ found: false });
  });

  it('routes comment replies and private replies to their own endpoints', async () => {
    await adapter.send({ kind: 'comment_reply', accountId: 'ig_1', commentId: 'c1', text: 'Sent you a DM!', clientRef: 'a' });
    await adapter.send({ kind: 'private_reply', accountId: 'ig_1', commentId: 'c1', text: 'email?', clientRef: 'b' });
    expect(ig.sent().map((m) => [m.kind, m.commentId])).toEqual([
      ['comment_reply', 'c1'],
      ['private_reply', 'c1'],
    ]);
  });

  it('a fault scoped to one kind does not hit other kinds', async () => {
    ig.pushFault({ mode: 'reject_permanent', kind: 'dm' });
    expect(
      (await adapter.send({ kind: 'comment_reply', accountId: 'ig_1', commentId: 'c', text: 't', clientRef: 'x' })).status,
    ).toBe('accepted');
    expect((await dm('y')).status).toBe('rejected');
  });
});

describe('CRM client and alert sink', () => {
  let crm: FakeCrm;
  let sink: FakeAlertSink;
  beforeAll(async () => {
    crm = await startFakeCrm();
    sink = await startFakeAlertSink();
  });
  afterAll(async () => {
    await crm.close();
    await sink.close();
  });

  const lead = { eventId: 'e1', leadId: 'l1', tenantId: 't1', email: 'a@b.io', source: { runId: 'r', commentId: 'c', mediaId: 'm' } };

  it('upserts idempotently by key: two deliveries, one record', async () => {
    const client = new HttpCrmClient(crm.url, { timeoutMs: 500 });
    await client.upsertLead(lead, 'lead:l1');
    await client.upsertLead(lead, 'lead:l1');
    expect(crm.records()).toHaveLength(1);
    expect(crm.deliveries()).toBe(2);
  });

  it('throws while the CRM is down', async () => {
    crm.setDown(true);
    const client = new HttpCrmClient(crm.url, { timeoutMs: 500 });
    await expect(client.upsertLead(lead, 'lead:l2')).rejects.toThrow(/503/);
    crm.setDown(false);
  });

  it('delivers alert text to the sink', async () => {
    await new HttpAlertSink(sink.url).notify('incident text');
    expect(sink.received()).toEqual(['incident text']);
  });
});
