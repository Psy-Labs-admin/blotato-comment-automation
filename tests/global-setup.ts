import { TestWorkflowEnvironment } from '@temporalio/testing';
import type { TestProject } from 'vitest/node';

let env: TestWorkflowEnvironment | undefined;

/**
 * Integration tests need a real Temporal server. If TEMPORAL_ADDRESS is set (e.g. the one from
 * compose.yaml) it is used; otherwise the official Temporal dev server is started once for the
 * whole run via @temporalio/testing (it downloads the Temporal CLI binary on first use).
 */
export async function setup(project: TestProject) {
  let address = process.env.TEMPORAL_ADDRESS;
  if (!address) {
    env = await TestWorkflowEnvironment.createLocal({ server: { ip: '127.0.0.1' } });
    address = env.address;
  }
  project.provide('temporalAddress', address);
}

export async function teardown() {
  await env?.teardown();
}

declare module 'vitest' {
  export interface ProvidedContext {
    temporalAddress: string;
  }
}
