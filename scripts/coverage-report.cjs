const fs = require('node:fs');
const path = require('node:path');
const { createCoverageMap } = require('istanbul-lib-coverage');
const { createContext } = require('istanbul-lib-report');
const reports = require('istanbul-reports');
const { createSourceMapStore } = require('istanbul-lib-source-maps');
const v8ToIstanbul = require('v8-to-istanbul');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'coverage');
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const uiAssets = new Map([
  ['/console.js', path.join(root, 'src/ui/console.js')],
  ['/session/enter.js', path.join(root, 'src/ui/enter.js')],
]);
const workflowDir = path.join(root, 'src/workflows') + path.sep;

function readShards(name) {
  const dir = path.join(root, 'reports', name);
  const shards = fs.readdirSync(dir).filter((file) => file.endsWith('.json'));
  if (!shards.length) throw new Error('No coverage captures found for ' + name);
  return shards.map((file) => read(path.join(dir, file)));
}

async function main() {
  const server = createCoverageMap(read(path.join(output, 'server/coverage-final.json')));
  // Temporal executes the same files in a separate isolate; use the SDK measurements for them.
  server.filter((file) => !file.startsWith(workflowDir));
  const rawWorkflow = createCoverageMap({});
  for (const shard of readShards('workflow-coverage')) rawWorkflow.merge(shard);
  const workflow = await createSourceMapStore().transformCoverage(rawWorkflow);
  if (!workflow.files().includes(path.join(workflowDir, 'commentAutomation.ts'))) {
    throw new Error('No source-mapped execution for the automation workflow');
  }

  const browser = createCoverageMap({});
  for (const shard of readShards('browser-v8')) {
    for (const entry of Array.isArray(shard) ? shard : [shard]) {
      const file = uiAssets.get(entry.url);
      if (!file || entry.source !== fs.readFileSync(file, 'utf8'))
        throw new Error('Unexpected browser script or stale test assets');
      const converter = v8ToIstanbul(file, 0, { source: entry.source });
      await converter.load();
      converter.applyCoverage(entry.functions);
      browser.merge(converter.toIstanbul());
      converter.destroy();
    }
  }
  for (const file of uiAssets.values()) {
    if (!browser.files().includes(file)) throw new Error('No browser execution data for ' + path.basename(file));
  }

  const groups = { server, workflow, browser };
  const all = createCoverageMap({});
  for (const group of Object.values(groups)) all.merge(group);
  const context = createContext({ dir: output, coverageMap: all });
  for (const name of ['html', 'json-summary', 'lcovonly', 'text-summary']) reports.create(name).execute(context);
  const policy = read(path.join(root, 'tests/coverage-policy.json'));
  const rows = [];
  const failures = [];
  const dimensions = ['lines', 'branches', 'functions', 'statements'];
  for (const [name, group] of Object.entries(groups)) {
    const summary = group.getCoverageSummary().toJSON();
    rows.push('| ' + [name, ...dimensions.map((key) => summary[key].pct + '%')].join(' | ') + ' |');
    for (const [key, floor] of Object.entries(policy[name])) {
      if (!summary[key].total || summary[key].pct < floor)
        failures.push(name + ' ' + key + ' below ' + floor + '%');
    }
  }
  const markdown = [
    '### Executed source coverage',
    '',
    '| Runtime | Lines | Branches | Functions | Statements |',
    '|---|---:|---:|---:|---:|',
    ...rows,
    '',
    'Workflow counts use the Temporal SDK interceptor. Browser counts use Chromium execution ranges.',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(output, 'summary.md'), markdown);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
  console.log(markdown);
  if (failures.length) throw new Error(failures.join(', '));
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
