import { readFileSync } from 'node:fs';
import path from 'node:path';
import { it } from 'vitest';
import { Worker } from '@temporalio/worker';

// Captured from the unpatched workflow at commit d0522dc on real Temporal. A valid email
// arrives while a clarification is throttled, exercising the command order changed by the patch.
it('replays the pre-review clarification history with the current workflow', async () => {
  const history = JSON.parse(readFileSync(path.resolve(__dirname, '../fixtures/pre-review-clarification-history.json'), 'utf8'));
  await Worker.runReplayHistory({ workflowsPath: path.resolve(__dirname, '../../src/workflows/index.ts') }, history);
});
