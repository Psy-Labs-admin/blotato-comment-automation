import { existsSync } from 'node:fs';
import path from 'node:path';
import { bundleWorkflowCode, NativeConnection, Worker, type WorkflowBundleWithSourceMap, type WorkerDeploymentOptions, type WorkerOptions } from '@temporalio/worker';
import { createActivities } from '../activities';
import type { ActivityDeps } from '../activities/deps';

export interface RunningWorker {
  state(): string;
  shutdown(): Promise<void>;
}

/** Setting both values opts this worker into pinned deployment versioning. */
export function workerDeploymentOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): WorkerDeploymentOptions | undefined {
  const deploymentName = env.TEMPORAL_DEPLOYMENT_NAME?.trim();
  const buildId = env.TEMPORAL_BUILD_ID?.trim();
  if (env.TEMPORAL_DEPLOYMENT_NAME === undefined && env.TEMPORAL_BUILD_ID === undefined) return undefined;
  if (!deploymentName || !buildId) throw new Error('TEMPORAL_DEPLOYMENT_NAME and TEMPORAL_BUILD_ID must be set together and nonempty');
  return { version: { deploymentName, buildId }, useWorkerVersioning: true, defaultVersioningBehavior: 'PINNED' };
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
  deploymentOptions?: WorkerDeploymentOptions;
  workflowBundle?: WorkflowBundleWithSourceMap;
  sinks?: WorkerOptions['sinks'];
}): Promise<RunningWorker> {
  const workflowBundle = o.workflowBundle ?? await (bundle ??= bundleWorkflowCode({ workflowsPath: workflowsPath(), logger: quietLogger }));
  const worker = await Worker.create({
    connection: o.connection,
    namespace: o.namespace ?? 'default',
    taskQueue: o.taskQueue,
    workflowBundle,
    sinks: o.sinks,
    activities: createActivities(o.deps),
    workerDeploymentOptions: o.deploymentOptions,
  });
  const running = worker.run();
  return {
    state: () => worker.getState(),
    async shutdown() {
      if (worker.getState() === 'RUNNING') worker.shutdown();
      await running;
    },
  };
}

const noop = () => undefined;
const quietLogger = { trace: noop, debug: noop, info: noop, warn: noop, error: console.error, log: noop };
