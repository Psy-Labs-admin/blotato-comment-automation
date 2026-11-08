import { condition, defineQuery, defineSignal, proxyActivities, setHandler } from '@temporalio/workflow';

const { identifyBuild } = proxyActivities<{ identifyBuild(): Promise<string> }>({ startToCloseTimeout: '5s' });

export async function versioningProbe(): Promise<string[]> {
  let proceed = false;
  const first = await identifyBuild();
  setHandler(defineQuery<string>('build'), () => first);
  setHandler(defineSignal('proceed'), () => { proceed = true; });
  await condition(() => proceed);
  return [first, await identifyBuild()];
}
