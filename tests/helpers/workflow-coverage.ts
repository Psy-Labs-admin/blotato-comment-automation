import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createCoverageMap } from 'istanbul-lib-coverage';
import { WorkflowCoverage } from '@temporalio/nyc-test-coverage';
import { bundleWorkflowCode, type WorkflowBundleWithSourceMap } from '@temporalio/worker';
import { startWorker } from '../../src/temporal/worker';

let bundle: Promise<WorkflowBundleWithSourceMap> | undefined;

/** The official SDK interceptor exports actual workflow decisions from the Temporal isolate. */
export async function startTestWorker(options: Parameters<typeof startWorker>[0]) {
  if (process.env.BLOTATO_WORKFLOW_COVERAGE !== '1') return startWorker(options);
  Object.assign(globalThis, { __coverage__: {} });
  const coverage = new WorkflowCoverage();
  bundle ??= bundleWorkflowCode(
    coverage.augmentBundleOptions({
      workflowsPath: path.resolve(__dirname, '../../src/workflows/index.ts'),
    }),
  );
  const worker = await startWorker({ ...options, workflowBundle: await bundle, sinks: coverage.sinks });
  return {
    ...worker,
    async shutdown() {
      try {
        await worker.shutdown();
      } finally {
        const directory = path.resolve('reports/workflow-coverage');
        mkdirSync(directory, { recursive: true });
        const result = createCoverageMap({});
        for (const activation of coverage.coverageMapsData) result.merge(activation);
        result.filter((file) => file.startsWith(path.resolve('src/workflows') + path.sep));
        writeFileSync(path.join(directory, randomUUID() + '.json'), JSON.stringify(result));
        coverage.coverageMapsData.length = 0;
      }
    },
  };
}
