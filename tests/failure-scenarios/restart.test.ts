import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../helpers/harness';
import { ingestEvent } from '../../src/ingest/ingest';
import { routePending } from '../../src/ingest/router';
import { systemClock } from '../../src/domain/clock';

describe('process restarts', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(async () => h?.close());

  it('worker down during the wait: the answer is kept, the run resumes on a new worker, the deadline does not move', async () => {
    const { runId } = await h.comment('restart_user');
    await h.waitForRun(runId!, 'waiting_input');
    const before = await h.wait(runId!);

    await h.stopWorker();
    await h.dm('restart_user', 'restart@example.com'); // ingested + signal buffered by Temporal while no worker runs
    await new Promise((r) => setTimeout(r, 500));
    expect(h.messagesFor('restart_user')).toHaveLength(0);

    await h.startWorker();
    expect((await h.waitForRun(runId!)).status).toBe('completed');
    expect(h.messagesFor('restart_user')).toHaveLength(1);
    const after = await h.wait(runId!);
    expect(after.deadline.getTime()).toBe(before.deadline.getTime());
  });

  it('relay down when the run was created: the start command waits in the outbox and is delivered later', async () => {
    await h.temporalRelay.stop();
    const { runId } = await h.comment('relay_down');
    await new Promise((r) => setTimeout(r, 300));
    expect((await h.run(runId!)).status).toBe('starting');
    h.temporalRelay.start();
    await h.waitForRun(runId!, 'waiting_input');
    await h.dm('relay_down', 'relay@example.com');
    expect((await h.waitForRun(runId!)).status).toBe('completed');
  });

  it('crash between webhook acknowledgement and routing: the sweeper routes the stored event', async () => {
    const res = await ingestEvent({ db: h.db, clock: systemClock }, h.rawComment('sweeper_user'));
    expect(res.status).toBe('accepted');
    expect((await h.db.query(`SELECT routing_status FROM inbox_events WHERE id = $1`, [(res as any).eventId])).rows[0].routing_status).toBe('pending');
    await routePending({ db: h.db, clock: systemClock, onOutbox: () => h.temporalRelay.poke() });
    const runId = (await h.db.query(`SELECT run_id FROM inbox_events WHERE id = $1`, [(res as any).eventId])).rows[0].run_id;
    await h.waitForRun(runId, 'waiting_input');
  });
});
