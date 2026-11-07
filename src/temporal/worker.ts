import { existsSync } from 'node:fs';
import path from 'node:path';
import { bundleWorkflowCode, NativeConnection, Worker, type WorkflowBundleWithSourceMap } from '@temporalio/worker';
import { createActivities } from '../activities';
import type { ActivityDeps } from '../activities/deps';

export interface RunningWorker {
  shutdown(): Promise<void>;
}

let bundle: Promise<WorkflowBundleWithSourceMap> | undefined;

function workflowsPath(): string {
  const ts = path.resolve(__dirname, '../workflows/index.ts');
  return existsSync(ts) ? ts : path.resolve(__dirname, '../workflows/index.js');
}

/** Bundles workflow code once per process (restarts in tests reuse it) and starts polling. */
export async function startWorker(o: {
  deps: ActivityDeps;
  connection: NativeConnection;
  taskQueue: string;
  namespace?: string;
}): Promise<RunningWorker> {
  bundle ??= bundleWorkflowCode({ workflowsPath: workflowsPath(), logger: quietLogger });
  const worker = await Worker.create({
    connection: o.connection,
    namespace: o.namespace ?? 'default',
    taskQueue: o.taskQueue,
    workflowBundle: await bundle,
    activities: createActivities(o.deps),
  });
  const running = worker.run();
  return {
    async shutdown() {
      if (worker.getState() === 'RUNNING') worker.shutdown();
      await running;
    },
  };
}

const noop = () => undefined;
const quietLogger = { trace: noop, debug: noop, info: noop, warn: noop, error: console.error, log: noop };
