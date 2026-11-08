// Exercises the shipped quickstart against an isolated database and installation.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { parseEnv } = require('node:util');
const { Pool } = require('pg');
const { root, freePort, localDatabase, delay, checkNode, command } = require('./local-runtime.cjs');

async function main() {
  checkNode();
  const dockerWorkspace = process.argv[2] === '--docker-workspace';
  if (process.argv.slice(2).some((arg) => arg !== '--docker-workspace'))
    throw new Error('Unknown workspace smoke option.');
  if (!dockerWorkspace && !process.env.DATABASE_ADMIN_URL)
    throw new Error('DATABASE_ADMIN_URL is required for the isolated workspace smoke test.');
  const adminUrl = dockerWorkspace ? undefined : localDatabase(process.env.DATABASE_ADMIN_URL);
  const name = 'smoke_' + randomUUID().replaceAll('-', '');
  const url = adminUrl && new URL(adminUrl);
  if (url) url.pathname = '/' + name;
  const admin = adminUrl && new Pool({ connectionString: adminUrl.toString(), max: 1 });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'blotato-workspace-smoke-'));
  const port = await freePort();
  const base = 'http://127.0.0.1:' + port;
  let child;
  let created = false;
  let output = '';
  const stop = async () => {
    if (!child) return;
    const processToStop = child;
    child = undefined;
    const alreadyExited = processToStop.exitCode !== null || processToStop.signalCode !== null;
    const exited = alreadyExited
      ? Promise.resolve()
      : new Promise((resolve) => processToStop.once('close', resolve));
    const signal = (value) => {
      try {
        process.kill(-processToStop.pid, value);
      } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
    };
    signal('SIGTERM');
    let timer;
    const complete = await Promise.race([
      exited.then(() => true),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(false), 10000);
        timer.unref();
      }),
    ]);
    clearTimeout(timer);
    if (!complete) {
      signal('SIGKILL');
      await exited;
    }
  };
  const start = async () => {
    output = '';
    const env = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      SystemRoot: process.env.SystemRoot,
      ...(url ? { DATABASE_URL: url.toString() } : {}),
      BLOTATO_LOCAL_DIR: directory,
      PORT: String(port),
      WORKSPACE_NAME: 'Workspace acceptance',
      // Canary values must never enter the installation's authoritative service configuration.
      TELEGRAM_BOT_TOKEN: 'invalid-canary',
      TELEGRAM_CHAT_ID: 'invalid-canary',
      INSTAGRAM_APP_ID: 'invalid-canary',
    };
    const program = process.env.npm_execpath ? process.execPath : 'npm';
    const args = [
      ...(process.env.npm_execpath ? [process.env.npm_execpath] : []),
      'run',
      'quickstart',
      '--',
      '--no-open',
    ];
    child = spawn(program, args, { cwd: root, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const startupError = (message) =>
      new Error(
        message +
          '\n' +
          output
            .replace(/postgres(?:ql)?:\/\/\S+/g, '[database]')
            .replace(/[a-f0-9]{64}/gi, '[redacted]')
            .slice(-3000),
      );
    let failed;
    child.once('error', (error) => {
      failed = error;
    });
    for (const stream of [child.stdout, child.stderr])
      stream.on('data', (data) => {
        output = (output + data.toString()).slice(-20000);
      });
    for (let attempt = 0; attempt < 480; attempt++) {
      if (failed || child.exitCode !== null || child.signalCode !== null)
        throw startupError('Quickstart exited before readiness.');
      try {
        if ((await fetch(base + '/health', { signal: AbortSignal.timeout(500) })).ok) return;
      } catch {}
      await delay(250);
    }
    throw startupError('Quickstart readiness timed out.');
  };
  let cookie;
  let csrf;
  const request = async (route, { method = 'GET', body, status = 200, authenticated = true } = {}) => {
    const response = await fetch(base + route, {
      method,
      redirect: 'manual',
      signal: AbortSignal.timeout(5000),
      headers: {
        origin: base,
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...(authenticated && cookie ? { cookie } : {}),
        ...(authenticated && csrf ? { 'x-csrf-token': csrf } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    assert.equal(response.status, status, method + ' ' + route + ' status');
    return response;
  };
  const json = async (...args) => (await request(...args)).json();
  try {
    if (admin) {
      await admin.query('CREATE DATABASE ' + name);
      created = true;
    }
    await start();
    const settings = parseEnv(fs.readFileSync(path.join(directory, 'operator/service.env'), 'utf8'));
    if (url) assert.equal(settings.DATABASE_URL, url.toString());
    else assert.equal(localDatabase(settings.DATABASE_URL).pathname, '/blotato');
    assert.equal(settings.DISPATCH_ENABLED, '0');
    assert.equal(settings.ROLE, 'api');
    assert(
      !Object.keys(settings).some((key) => /TELEGRAM|INSTAGRAM|META|CRM|ALERT|TEMPORAL/i.test(key)),
      'Provider settings must not be inherited',
    );
    const credentials = JSON.parse(fs.readFileSync(path.join(directory, 'operator/credentials.json'), 'utf8'));
    assert.equal(fs.statSync(path.join(directory, 'operator/credentials.json')).mode & 0o777, 0o600);
    await request('/operator/overview', { authenticated: false, status: 401 });
    await request('/session', { method: 'POST', body: { token: 'invalid' }, authenticated: false, status: 401 });
    const login = await request('/session', {
      method: 'POST',
      body: { token: credentials.operator },
      authenticated: false,
    });
    cookie = login.headers.get('set-cookie')?.split(';')[0];
    csrf = (await login.json()).csrfToken;
    assert(cookie && csrf, 'Authenticated session requires cookie and CSRF token');
    const overview = await json('/operator/overview');
    for (const key of ['automationsActive', 'drafts', 'conversationsStarted', 'emailsCollected', 'needsAttention'])
      assert.equal(overview[key], 0, key + ' starts empty');
    assert.equal(overview.readiness.accountConnected, false);
    assert.equal(overview.readiness.dispatchConfigured, false);
    assert.deepEqual(await json('/operator/accounts'), { accounts: [] });
    assert.deepEqual(await json('/operator/automations'), { drafts: [], automations: [] });
    const operations = await json('/operator/operations');
    assert.equal(operations.notifications.configured, false);
    assert.equal(operations.notifications.lastAcceptedAt, null);
    assert(
      operations.queues.every((queue) => queue.pending === 0 && queue.dead === 0),
      'No invented queued work',
    );
    assert.equal((await request('/console')).headers.get('content-type')?.includes('text/html'), true);
    // A cookie alone must not authorize writes.
    const savedCsrf = csrf;
    csrf = undefined;
    await request('/operator/automations', { method: 'POST', body: { name: 'Rejected write' }, status: 403 });
    csrf = savedCsrf;
    const { draft } = await json('/operator/automations', {
      method: 'POST',
      body: { name: 'Acceptance draft' },
      status: 201,
    });
    assert.equal(draft.name, 'Acceptance draft');
    assert.equal(draft.connectionId, null);
    await stop();
    await start();
    // Both browser session and draft survive the normal launcher restart.
    const restored = await json('/operator/automations/' + draft.id);
    assert.equal(restored.draft.name, 'Acceptance draft');
    assert.equal(restored.draft.id, draft.id);
    assert.equal((await json('/operator/overview')).drafts, 1);
    const restartedOperations = await json('/operator/operations');
    assert.equal(restartedOperations.notifications.configured, false);
    assert.equal(restartedOperations.notifications.lastAcceptedAt, null);
    const workspace = new Pool({ connectionString: settings.DATABASE_URL, max: 1 });
    try {
      for (const table of [
        'social_connections',
        'inbox_events',
        'automation_runs',
        'leads',
        'message_intents',
        'outbox',
        'alert_deliveries',
      ]) {
        assert.equal(
          (await workspace.query('SELECT count(*)::int AS n FROM ' + table)).rows[0].n,
          0,
          table + ' remains empty',
        );
      }
    } finally {
      await workspace.end();
    }
    console.log(
      'Workspace smoke passed: quickstart, authentication/CSRF, empty Operations, draft/session persistence, no connected providers.',
    );
  } finally {
    await stop();
    try {
      if (created) await admin.query('DROP DATABASE ' + name + ' WITH (FORCE)');
      const stateFile = path.join(directory, 'local-postgres.json');
      if (dockerWorkspace && fs.existsSync(stateFile)) {
        const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        assert.match(state.project, /^blotato-[0-9a-f]{8}-[0-9a-f]{3}$/);
        await command(
          'docker',
          ['compose', '-p', state.project, '-f', 'compose.workspace.yaml', 'down', '--volumes'],
          { env: { ...process.env, BLOTATO_DB_PASSWORD: state.password, BLOTATO_DB_PORT: String(state.port) } },
        );
      }
    } finally {
      await admin?.end();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }
}
main().catch((error) => {
  console.error('Workspace smoke failed: ' + error.message);
  process.exitCode = 1;
});
