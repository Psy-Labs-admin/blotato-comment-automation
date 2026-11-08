import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../helpers/harness';
import { pricingWith } from '../helpers/definitions';
import { publishVersion } from '../../src/storage/admin';

describe('comment automation workflow (real Temporal + Postgres + HTTP fakes)', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(async () => h?.close());

  it('happy path: public reply, DM question, email, DM link — each sent once, in order', async () => {
    const { runId } = await h.comment('alice');
    await h.waitForRun(runId!, 'waiting_input');
    await h.dm('alice', 'sure, alice@example.com');
    const run = await h.waitForRun(runId!);
    expect(run.status).toBe('completed');

    const sent = h.ig.sent().filter((m) => m.commentId === undefined ? m.recipientId === 'alice' : true);
    expect(sent.map((m) => m.kind)).toEqual(['comment_reply', 'private_reply', 'dm']);
    expect(sent[0].text).toBe('Sent you a DM!');
    expect(sent[2].text).toContain('https://example.com/pricing');

    const lead = await h.waitFor(async () => {
      const l = await h.lead(runId!);
      return l?.crm_status === 'synced' ? l : undefined;
    }, 10_000, 'lead synced');
    expect(lead.email).toBe('alice@example.com');
    expect(h.crm.records()).toHaveLength(1);
    expect((await h.conversationOf(runId!)).owner_run_id).toBeNull();
  });

  it('an invalid answer gets one clarification, then a valid one completes the run', async () => {
    const { runId } = await h.comment('bob');
    await h.waitForRun(runId!, 'waiting_input');
    await h.dm('bob', 'why do you need it?');
    await h.waitFor(async () => h.ig.sent().some((m) => m.recipientId === 'bob' && m.text.includes("doesn't look like")), 10_000, 'clarification');
    await h.dm('bob', 'bob@example.com');
    expect((await h.waitForRun(runId!)).status).toBe('completed');
    const dms = h.ig.sent().filter((m) => m.recipientId === 'bob');
    expect(dms).toHaveLength(2); // clarification + link
  });

  it('no answer before the deadline expires the run and releases the conversation', async () => {
    await publishVersion(h.db, { dispatchConfigured: true, integrationMode: 'gateway', tenantId: h.tenant.tenantId, automationId: h.automation.automationId, definition: pricingWith({ timeout: '2s' }) });
    const { runId } = await h.comment('carol');
    const run = await h.waitForRun(runId!, undefined, 15_000);
    expect(run.status).toBe('expired');
    expect(h.ig.sent().filter((m) => m.recipientId === 'carol')).toHaveLength(0);
    expect((await h.conversationOf(runId!)).owner_run_id).toBeNull();
    const wait = await h.wait(runId!);
    expect(wait.status).toBe('expired');
  });

  it('a valid reply interrupts a throttled clarification and completes without sending that clarification', async () => {
    await publishVersion(h.db, { dispatchConfigured: true, integrationMode: 'gateway', tenantId: h.tenant.tenantId, automationId: h.automation.automationId, definition: pricingWith({ timeout: '30s' }) });
    const platform = h.deps.platform;
    h.deps.platform = {
      send: async (request) => request.text.includes("doesn't look like")
        ? { status: 'not_sent' as const, code: 'throttled', retryAfterMs: 60_000, httpStatus: 429 }
        : platform.send(request),
    };
    try {
      const { runId } = await h.comment('clarification_backoff');
      await h.waitForRun(runId!, 'waiting_input');
      await h.dm('clarification_backoff', 'why?');
      await h.waitFor(async () => (await h.intents(runId!)).find((intent) => intent.step_id === 'email' && intent.status === 'pending'), 5_000, 'throttled clarification');
      await h.dm('clarification_backoff', 'ready@example.com');
      expect((await h.waitForRun(runId!, undefined, 4_000)).status).toBe('completed');
      expect(h.messagesFor('clarification_backoff')).toHaveLength(1);
      expect((await h.lead(runId!)).email).toBe('ready@example.com');
    } finally {
      h.deps.platform = platform;
    }
  });

  it('a version published while a run waits does not change that run; new runs use it', async () => {
    await publishVersion(h.db, { dispatchConfigured: true, integrationMode: 'gateway', tenantId: h.tenant.tenantId, automationId: h.automation.automationId, definition: pricingWith({ timeout: '30s', link: 'https://example.com/v-old' }) });
    const { runId: oldRun } = await h.comment('dave');
    await h.waitForRun(oldRun!, 'waiting_input');
    await publishVersion(h.db, { dispatchConfigured: true, integrationMode: 'gateway', tenantId: h.tenant.tenantId, automationId: h.automation.automationId, definition: pricingWith({ timeout: '30s', link: 'https://example.com/v-new' }) });
    await h.dm('dave', 'dave@example.com');
    await h.waitForRun(oldRun!);
    expect(h.ig.sent().find((m) => m.recipientId === 'dave')!.text).toContain('v-old');

    const { runId: newRun } = await h.comment('erin');
    await h.waitForRun(newRun!, 'waiting_input');
    await h.dm('erin', 'erin@example.com');
    await h.waitForRun(newRun!);
    expect(h.ig.sent().find((m) => m.recipientId === 'erin')!.text).toContain('v-new');
  });
});
