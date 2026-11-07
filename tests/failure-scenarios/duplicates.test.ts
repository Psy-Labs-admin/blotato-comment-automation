import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../helpers/harness';
import { dmEvent } from '../helpers/fixtures';

describe('duplicate deliveries', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(async () => h?.close());

  it('one comment delivered five times concurrently produces one run and exactly three messages', async () => {
    const ev = h.rawComment('dup_user', { commentId: 'dup_comment' });
    const routes = await Promise.all(Array.from({ length: 5 }, () => h.deliver(ev)));
    const runIds = new Set(routes.map((r) => r.runId));
    expect(runIds.size).toBe(1);
    const runId = [...runIds][0]!;
    await h.waitForRun(runId, 'waiting_input');
    await h.dm('dup_user', 'dup@example.com');
    expect((await h.waitForRun(runId)).status).toBe('completed');
    expect(h.messagesFor('dup_user', 'dup_comment').map((m) => m.kind)).toEqual(['comment_reply', 'private_reply', 'dm']);
  });

  it('the same DM webhook delivered twice is consumed once and sends one link', async () => {
    const { runId } = await h.comment('dup_dm_user');
    await h.waitForRun(runId!, 'waiting_input');
    const dm = dmEvent({ accountId: h.tenant.accountId, from: 'dup_dm_user', text: 'x@example.com', messageId: 'same_mid' });
    await Promise.all([h.deliver(dm), h.deliver(dm)]);
    await h.waitForRun(runId!);
    expect(h.messagesFor('dup_dm_user')).toHaveLength(1);
    const consumed = await h.db.query(
      `SELECT count(*)::int AS n FROM input_consumptions ic JOIN input_waits w ON w.id = ic.wait_id WHERE w.run_id = $1`,
      [runId],
    );
    expect(consumed.rows[0].n).toBe(1);
  });

  it('a burst of wake-up signals does not cause extra transitions', async () => {
    const { runId } = await h.comment('signal_storm');
    await h.waitForRun(runId!, 'waiting_input');
    const run = await h.run(runId!);
    const handle = h.client.workflow.getHandle(run.workflow_id);
    await Promise.all(Array.from({ length: 10 }, () => handle.signal('inboxChanged')));
    await h.dm('signal_storm', 'storm@example.com');
    await Promise.all(Array.from({ length: 10 }, () => handle.signal('inboxChanged')));
    expect((await h.waitForRun(runId!)).status).toBe('completed');
    expect(h.messagesFor('signal_storm')).toHaveLength(1);
  });
});
