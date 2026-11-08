const fs = require('node:fs');
const path = require('node:path');
const { root, checkNode, command, npm, installDependencies, temporaryPostgres } = require('./local-runtime.cjs');

const reports = path.join(root, 'reports');
const acceptance = path.join(reports, 'acceptance');
const stages = [];
async function step(name, action) {
  const start = Date.now();
  console.log('\n' + name);
  let passed = false;
  try {
    await action();
    passed = true;
  } finally {
    stages.push({ name, passed, seconds: Math.round((Date.now() - start) / 100) / 10 });
    fs.writeFileSync(path.join(acceptance, 'checks.json'), JSON.stringify(stages, null, 2) + '\n');
  }
}

function testEnvironment(adminUrl) {
  const env = { DATABASE_ADMIN_URL: adminUrl, BLOTATO_WORKFLOW_COVERAGE: '1' };
  for (const key of [
    'PATH',
    'HOME',
    'TMPDIR',
    'TEMP',
    'TMP',
    'SystemRoot',
    'USERPROFILE',
    'LOCALAPPDATA',
    'CI',
    'PLAYWRIGHT_BROWSERS_PATH',
    'PLAYWRIGHT_CHROMIUM_EXECUTABLE',
    'GITHUB_STEP_SUMMARY',
    'npm_execpath',
    'HTTPS_PROXY',
    'HTTP_PROXY',
    'NO_PROXY',
    'NODE_EXTRA_CA_CERTS',
    'SSL_CERT_FILE',
  ]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

async function main() {
  checkNode();
  // Discard only this runner's generated results. Captures from a previous version are invalid.
  for (const dir of ['browser-v8', 'workflow-coverage', 'acceptance']) {
    fs.rmSync(path.join(reports, dir), { recursive: true, force: true });
  }
  fs.rmSync(path.join(reports, 'tests.xml'), { force: true });
  fs.rmSync(path.join(reports, 'browser.xml'), { force: true });
  fs.rmSync(path.join(root, 'coverage'), { recursive: true, force: true });
  fs.mkdirSync(acceptance, { recursive: true });
  await step('Install locked dependencies', installDependencies);
  await step('Type-check', () => npm(['run', 'typecheck']));
  await step('Build the release', () => npm(['run', 'build']));
  const playwright = path.join(root, 'node_modules/@playwright/test/cli.js');
  await step('Install Chromium', () =>
    command(process.execPath, [
      playwright,
      'install',
      ...(process.env.CI && process.platform === 'linux' ? ['--with-deps'] : []),
      '--only-shell',
      'chromium',
    ]),
  );
  await temporaryPostgres(async (url) => {
    const env = testEnvironment(url);
    await step('Server and Temporal scenarios', () =>
      command(
        process.execPath,
        [
          'node_modules/vitest/vitest.mjs',
          'run',
          '--coverage',
          '--reporter=default',
          '--reporter=junit',
          '--outputFile.junit=reports/tests.xml',
        ],
        { env },
      ),
    );
    await step('Desktop and mobile browser journeys', () =>
      command(process.execPath, [playwright, 'test'], { env }),
    );
    await step('Enforce coverage floors', () =>
      command(process.execPath, ['scripts/coverage-report.cjs'], { env }),
    );
    await step('Start, save and restart a fresh workspace', () =>
      command(process.execPath, ['scripts/workspace-smoke.cjs'], { env }),
    );
    await step('Drain duplicate traffic end to end', () =>
      npm(['run', 'test:load'], {
        env: {
          ...env,
          BLOTATO_WORKFLOW_COVERAGE: '0',
          LOAD_RATE: '25',
          LOAD_DELIVERIES: '50',
          LOAD_REPORT_PATH: path.join(acceptance, 'load.json'),
        },
      }),
    );
  });
  console.log(
    '\nVerification passed. Open coverage/index.html for source coverage or reports/acceptance for check results.',
  );
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
