import { expect, it } from 'vitest';
import { workerDeploymentOptionsFromEnv } from '../../src/temporal/worker';

it('keeps deployment pinning opt-in and validates paired configuration', () => {
  expect(workerDeploymentOptionsFromEnv({})).toBeUndefined();
  expect(workerDeploymentOptionsFromEnv({ TEMPORAL_DEPLOYMENT_NAME: 'comments', TEMPORAL_BUILD_ID: 'v1' })).toEqual({
    version: { deploymentName: 'comments', buildId: 'v1' }, useWorkerVersioning: true, defaultVersioningBehavior: 'PINNED',
  });
  for (const env of [{ TEMPORAL_DEPLOYMENT_NAME: 'comments' }, { TEMPORAL_BUILD_ID: 'v1' },
    { TEMPORAL_DEPLOYMENT_NAME: '', TEMPORAL_BUILD_ID: 'v1' }]) {
    expect(() => workerDeploymentOptionsFromEnv(env)).toThrow('must be set together');
  }
});
