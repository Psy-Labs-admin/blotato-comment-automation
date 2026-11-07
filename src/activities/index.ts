import type { ActivityDeps } from './deps';
import { executeSend, reconcileIntent } from './send';
import { activateWait, evaluateWait, prepareWait } from './waits';
import { finalizeRun, setRunStatus } from './runs';

/** Activities are the only place with I/O; each one is idempotent and safe to retry. */
export function createActivities(deps: ActivityDeps) {
  return {
    executeSend: (i: Parameters<typeof executeSend>[1]) => executeSend(deps, i),
    reconcileIntent: (i: Parameters<typeof reconcileIntent>[1]) => reconcileIntent(deps, i),
    prepareWait: (i: Parameters<typeof prepareWait>[1]) => prepareWait(deps, i),
    activateWait: (i: Parameters<typeof activateWait>[1]) => activateWait(deps, i),
    evaluateWait: (i: Parameters<typeof evaluateWait>[1]) => evaluateWait(deps, i),
    finalizeRun: (i: Parameters<typeof finalizeRun>[1]) => finalizeRun(deps, i),
    setRunStatus: (i: Parameters<typeof setRunStatus>[1]) => setRunStatus(deps, i),
  };
}

export type Activities = ReturnType<typeof createActivities>;
