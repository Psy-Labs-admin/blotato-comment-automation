import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../helpers/harness';

describe('CRM outage, revoked access and alerting', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(async () => h?.close());

  it('CRM down: the person still gets the link; the lead syncs exactly once after recovery; incident opens and resolves', async () => {
    h.crm.setDown(true);
    const { runId } = await h.comment('crm_user');
    await h.waitForRun(runId!, 'waiting_input');
    await h.dm('crm_user', 'crm@example.com');
    expect((await h.waitForRun(runId!)).status).toBe('completed');
    expect(h.messagesFor('crm_user')).toHaveLength(1);
    expect((await h.lead(runId!)).crm_status).toBe('pending');

    await h.waitFor(async () => h.alerts.received().find((t) => t.includes('CRM sync failing')), 15_000, 'CRM incident alert');
    const timeline = await h.request('GET', `/runs/${runId}/timeline`);
    expect(timeline.body.entries.at(-1).text).toBe('CRM: waiting for retry');

    h.crm.setDown(false);
    await h.waitFor(async () => (await h.lead(runId!)).crm_status === 'synced', 15_000, 'lead synced');
    expect(h.crm.records()).toHaveLength(1);
    await h.waitFor(async () => h.alerts.received().find((t) => t.startsWith('[RESOLVED] CRM sync failing')), 10_000, 'resolved alert');
  });

  it('revoked Instagram access: run fails, account sends pause, one actionable alert without personal data', async () => {
    h.ig.pushFault({ mode: 'unauthorized', kind: 'comment_reply' });
    const { runId } = await h.comment('revoked_user');
    const run = await h.waitForRun(runId!);
    expect(run).toMatchObject({ status: 'failed', status_reason: 'provider_unauthorized' });
    const conn = (await h.db.query(`SELECT status, sends_paused FROM social_connections WHERE id = $1`, [h.tenant.connectionId])).rows[0];
    expect(conn).toEqual({ status: 'unauthorized', sends_paused: true });
    const alert = await h.waitFor(async () => h.alerts.received().find((t) => t.includes('access revoked')), 10_000, 'auth alert');
    expect(alert).toContain('reconnect');
    expect(alert).not.toContain('revoked_user');

    // New triggers on the revoked account do not even start a run; nothing is sent.
    const sentBefore = h.ig.sent().length;
    const second = await h.comment('another_user');
    expect(second).toMatchObject({ outcome: 'connection_inactive', runId: null });
    expect(h.ig.sent().length).toBe(sentBefore);

    // Reconnect -> incident resolved.
    expect((await h.request('POST', `/connections/${h.tenant.connectionId}/resume`)).status).toBe(200);
    await h.waitFor(async () => h.alerts.received().find((t) => t.startsWith('[RESOLVED] Instagram account access')), 10_000, 'resolved');
  });
});
