import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';

export type ServiceRole = 'worker' | 'relay';
export const HEARTBEAT_STALE_SECONDS = 45;

export interface HeartbeatOptions {
  db: Pool;
  role: ServiceRole;
  namespace: string;
  taskQueue: string;
  capabilities?: string[];
  probe(): Promise<boolean>;
  onError?(error: unknown): void;
  intervalMs?: number;
}

/** Written by the running process after its dependency and work-loop probes have completed. */
export async function startServiceHeartbeat(options: HeartbeatOptions): Promise<{ stop(): Promise<void> }> {
  const id = randomUUID();
  const startedAt = new Date();
  let stopped = false;
  let pending: Promise<void> | undefined;
  async function observe() {
    let ready = false;
    try {
      ready = await options.probe();
    } catch (error) {
      options.onError?.(error);
    }
    await options.db.query(
      `INSERT INTO service_heartbeats(instance_id,role,temporal_namespace,task_queue,state,started_at,observed_at,capabilities)
       VALUES ($1,$2,$3,$4,$5,$6,clock_timestamp(),$7)
       ON CONFLICT(instance_id) DO UPDATE SET state=excluded.state,observed_at=excluded.observed_at,capabilities=excluded.capabilities`,
      [
        id,
        options.role,
        options.namespace,
        options.taskQueue,
        ready ? 'ready' : 'degraded',
        startedAt,
        (options.capabilities ?? [])
          .filter(
            (cap) =>
              ['dispatch', 'crm', 'alerts', 'metadata'].includes(cap) ||
              /^alert\.(telegram|webhook):[a-f0-9]{64}$/.test(cap),
          )
          .slice(0, 8),
      ],
    );
  }
  await observe();
  const timer = setInterval(() => {
    if (stopped || pending) return;
    pending = observe()
      .catch((error) => options.onError?.(error))
      .finally(() => {
        pending = undefined;
      });
  }, options.intervalMs ?? 10_000);
  timer.unref();
  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      await pending;
      await options.db.query(
        "UPDATE service_heartbeats SET state='stopping',observed_at=clock_timestamp() WHERE instance_id=$1",
        [id],
      );
    },
  };
}
