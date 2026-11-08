import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../helpers/harness';
import { reconcileOrphans } from '../../src/relay/orphans';
import { systemClock } from '../../src/domain/clock';
import type { Client } from '@temporalio/client';

describe('workflow start exhaustion', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
    await h.temporalRelay.stop();
  });
  afterAll(async () => h?.close());

  it('rotates a bounded inspection batch past healthy long-running workflows', async () => {
    const first = await h.comment('healthy_first');
    const second = await h.comment('orphan_second');
    await h.db.query(
      `UPDATE automation_runs SET status = 'running', updated_at = now() - CASE WHEN id = $1 THEN interval '2 hours' ELSE interval '1 hour' END
        WHERE id = ANY($2::uuid[])`, [first.runId, [first.runId, second.runId]],
    );
    const firstRun = await h.run(first.runId!);
    const seen: string[] = [];
    const client = { workflow: { getHandle: (workflowId: string) => ({ describe: async () => {
      seen.push(workflowId);
      return { status: { name: workflowId === firstRun.workflow_id ? 'RUNNING' : 'FAILED' } };
    } }) } } as unknown as Client;
    const reconcile = () => reconcileOrphans({ db: h.db, client, clock: systemClock, olderThanMs: 0, limit: 1 });
    expect(await reconcile()).toBe(0);
    expect(await reconcile()).toBe(1);
    expect(new Set(seen).size).toBe(2);
    expect((await h.run(first.runId!)).updated_at).toEqual(firstRun.updated_at);
    expect(await h.run(second.runId!)).toMatchObject({ status: 'failed', status_reason: 'workflow_closed' });
    // This test uses a read-only Temporal stub for the healthy workflow, so finalize its
    // database row before the next scenario that checks missing real workflows.
    await h.db.query(`UPDATE automation_runs SET finished_at = now(), status = 'cancelled' WHERE id = $1`, [first.runId]);
  });

  it('preserves queued starts and finalizes a never-started run after dead-lettering', async () => {
    const { runId } = await h.comment('start_failed');
    const reconcile = () => reconcileOrphans({ db: h.db, client: h.client, clock: systemClock, olderThanMs: 0 });
    expect(await reconcile()).toBe(0);
    expect(await h.run(runId!)).toMatchObject({ status: 'starting', finished_at: null });
    await h.db.query(`UPDATE outbox SET status = 'dead' WHERE kind = 'workflow.start' AND payload->>'runId' = $1`, [runId]);
    expect(await reconcile()).toBe(1);
    expect(await h.run(runId!)).toMatchObject({ status: 'failed', status_reason: 'workflow_closed' });
    expect((await h.conversationOf(runId!)).owner_run_id).toBeNull();
  });
});
