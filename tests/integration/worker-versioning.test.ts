import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { expect, it } from 'vitest';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { workerDeploymentOptionsFromEnv } from '../../src/temporal/worker';

it('keeps an existing run pinned to v1 after promoting v2 on a separate local Temporal server', async () => {
  const env = await TestWorkflowEnvironment.createLocal({ server: { ip: '127.0.0.1' } });
  const deploymentName = `probe-${randomUUID().slice(0, 8)}`;
  const taskQueue = `versioning-${randomUUID()}`;
  const workers: Array<{ worker: Worker; running: Promise<void> }> = [];
  const handles: Array<ReturnType<typeof env.client.workflow.getHandle>> = [];
  const waitFor = async (fn: () => Promise<boolean>) => {
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      if (await fn()) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('Timed out waiting for worker deployment registration');
  };
  const start = async (buildId: string) => {
    const worker = await Worker.create({ connection: env.nativeConnection, taskQueue,
      workflowsPath: path.resolve(__dirname, '../fixtures/versioning-probe.ts'), maxCachedWorkflows: 0,
      activities: { identifyBuild: async () => buildId },
      workerDeploymentOptions: workerDeploymentOptionsFromEnv({ TEMPORAL_DEPLOYMENT_NAME: deploymentName, TEMPORAL_BUILD_ID: buildId }),
    });
    workers.push({ worker, running: worker.run() });
    await waitFor(async () => {
      try {
        await env.client.workflowService.describeWorkerDeploymentVersion({ namespace: 'default', deploymentVersion: { deploymentName, buildId } });
        return true;
      } catch (err) {
        if ((err as { code?: number }).code === 5) return false;
        throw err;
      }
    });
  };
  const promote = async (buildId: string) => {
    await env.client.workflowService.setWorkerDeploymentCurrentVersion({ namespace: 'default', deploymentName, buildId, identity: 'isolated-versioning-test' });
  };
  try {
    await start('v1');
    await promote('v1');
    const old = await env.client.workflow.start('versioningProbe', { workflowId: `old-${randomUUID()}`, taskQueue });
    handles.push(old);
    await waitFor(async () => { try { return await old.query('build') === 'v1'; } catch { return false; } });
    await start('v2');
    await promote('v2');
    const fresh = await env.client.workflow.start('versioningProbe', { workflowId: `fresh-${randomUUID()}`, taskQueue });
    handles.push(fresh);
    await waitFor(async () => { try { return await fresh.query('build') === 'v2'; } catch { return false; } });
    await Promise.all([old.signal('proceed'), fresh.signal('proceed')]);
    expect(await old.result()).toEqual(['v1', 'v1']);
    expect(await fresh.result()).toEqual(['v2', 'v2']);
    const details = await env.client.workflowService.describeWorkflowExecution({ namespace: 'default', execution: { workflowId: old.workflowId } });
    expect(details.workflowExecutionInfo?.versioningInfo?.deploymentVersion?.buildId).toBe('v1');
    expect(details.workflowExecutionInfo?.versioningInfo?.behavior).toBe(1);
  } finally {
    await Promise.allSettled(handles.map((handle) => handle.terminate('isolated test cleanup')));
    for (const { worker } of workers) if (worker.getState() === 'RUNNING') worker.shutdown();
    await Promise.allSettled(workers.map(({ running }) => running));
    await env.teardown();
  }
}, 40_000);
