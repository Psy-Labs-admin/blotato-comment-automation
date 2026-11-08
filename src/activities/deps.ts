import type { Tracing } from '../observability/tracing';
import type { Pool } from 'pg';
import type { SocialPlatform } from '../adapters/instagram';
import type { Clock } from '../domain/clock';

/**
 * Fault-injection points used by the failure-scenario tests to simulate a worker dying at the two
 * most dangerous moments of an external send. Throwing here behaves exactly like a crash from the
 * ledger's point of view: nothing after the hook is executed and the activity attempt fails.
 */
export interface CrashHooks {
  afterProviderCall?(intentId: string, ctx: { stepId: string; actionNo: number }): void;
  afterResultCommit?(intentId: string, ctx: { stepId: string; actionNo: number }): void;
}

export class SimulatedCrash extends Error {
  constructor(where: string) {
    super(`simulated worker crash: ${where}`);
    this.name = 'SimulatedCrash';
  }
}

export interface ActivityDeps {
  tracing?: Tracing;
  db: Pool;
  clock: Clock;
  platform: SocialPlatform;
  hooks?: CrashHooks;
  onOutbox?: () => void;
}
