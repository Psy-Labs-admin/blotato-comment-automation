import type { TraceOperation } from '../observability/tracing';
import type { ActivityDeps } from './deps';
import { executeSend, reconcileIntent } from './send';
import { activateWait, evaluateWait, prepareWait } from './waits';
import { finalizeRun, readRunControl, setRunStatus } from './runs';

/** Activities are the only place with I/O; each one is idempotent and safe to retry. */
export function createActivities(deps: ActivityDeps) {
  function measure<T>(name: TraceOperation, work: () => Promise<T>): Promise<T> {
    return deps.tracing ? deps.tracing.withSpan(name, work) : work();
  }
  return {
    executeSend: (i: Parameters<typeof executeSend>[1]) => measure('automation.send', () => executeSend(deps, i)),
    reconcileIntent: (i: Parameters<typeof reconcileIntent>[1]) => measure('automation.send', () => reconcileIntent(deps, i)),
    prepareWait: (i: Parameters<typeof prepareWait>[1]) => measure('automation.wait', () => prepareWait(deps, i)),
    activateWait: (i: Parameters<typeof activateWait>[1]) => measure('automation.wait', () => activateWait(deps, i)),
    evaluateWait: (i: Parameters<typeof evaluateWait>[1]) => measure('automation.wait', () => evaluateWait(deps, i)),
    finalizeRun: (i: Parameters<typeof finalizeRun>[1]) => measure('automation.finalize', () => finalizeRun(deps, i)),
    setRunStatus: (i: Parameters<typeof setRunStatus>[1]) => setRunStatus(deps, i),
    readRunControl: (i: Parameters<typeof readRunControl>[1]) => readRunControl(deps, i),
  };
}

export type Activities = ReturnType<typeof createActivities>;
