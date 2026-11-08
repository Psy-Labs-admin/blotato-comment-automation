const { spawn } = require('node:child_process');
const { randomBytes, randomUUID } = require('node:crypto');
const { once } = require('node:events');
const net = require('node:net');
const path = require('node:path');
const fs = require('node:fs');

const root = path.resolve(__dirname, '..');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function checkNode() {
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Node 24 or later is required.');
}
function command(program, args, { env = process.env, capture = false, handle } = {}) {
  const child = spawn(program, args, {
    cwd: root,
    env,
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
  });
  if (handle) handle(child);
  let output = '';
  if (capture)
    child.stdout.on('data', (value) => {
      output += value;
    });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) =>
      code === 0
        ? resolve(output.trim())
        : reject(new Error(path.basename(program) + ' exited with ' + (signal ?? code))),
    );
  });
}
function npm(args, options) {
  // npm passes the CLI path even on Windows, avoiding shell parsing of arguments.
  if (process.env.npm_execpath) return command(process.execPath, [process.env.npm_execpath, ...args], options);
  return command(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, options);
}
async function freePort(preferred = 0) {
  const listener = net.createServer();
  listener.listen(preferred, '127.0.0.1');
  await once(listener, 'listening');
  const port = listener.address().port;
  await new Promise((resolve, reject) => listener.close((err) => (err ? reject(err) : resolve())));
  return port;
}
async function installDependencies() {
  const { createHash } = require('node:crypto');
  const lock = createHash('sha256')
    .update(fs.readFileSync(path.join(root, 'package-lock.json')))
    .digest('hex');
  const stamp = path.join(root, 'node_modules/.blotato-lock');
  if (fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8') === lock) return;
  await npm(['ci', '--no-fund']);
  fs.writeFileSync(stamp, lock);
}
function localDatabase(value) {
  const url = new URL(value);
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.search ||
    url.hash
  ) {
    throw new Error('Use a dedicated loopback PostgreSQL URL without host overrides.');
  }
  return url;
}
async function waitForPostgres(url) {
  const { Client } = require('pg');
  for (let attempt = 0; attempt < 80; attempt++) {
    const client = new Client({ connectionString: url, connectionTimeoutMillis: 700 });
    try {
      await client.connect();
      await client.query('SELECT 1');
      return;
    } catch {
      await delay(250);
    } finally {
      await client.end().catch(() => {});
    }
  }
  throw new Error('Local PostgreSQL did not become ready.');
}

async function temporaryPostgres(use) {
  if (process.env.DATABASE_ADMIN_URL) return use(localDatabase(process.env.DATABASE_ADMIN_URL).toString());
  const password = randomBytes(24).toString('hex');
  const name = 'blotato-verify-' + randomUUID();
  // The disposable database is only reachable over loopback. Remove only our exact container ID.
  const id = await command(
    'docker',
    [
      'run',
      '--detach',
      '--rm',
      '--name',
      name,
      '-e',
      'POSTGRES_PASSWORD',
      '--tmpfs',
      '/var/lib/postgresql/data',
      '-p',
      '127.0.0.1::5432',
      'postgres:16-alpine',
    ],
    {
      env: { ...process.env, POSTGRES_PASSWORD: password },
      capture: true,
    },
  );
  try {
    const binding = await command('docker', ['port', id, '5432/tcp'], { capture: true });
    const port = /^127\.0\.0\.1:(\d+)$/.exec(binding)?.[1];
    if (!port) throw new Error('Expected a loopback PostgreSQL port.');
    const url = 'postgres://postgres:' + password + '@127.0.0.1:' + port + '/postgres';
    await waitForPostgres(url);
    return await use(url);
  } finally {
    await command('docker', ['rm', '--force', id]);
  }
}

async function workspaceDatabase(directory) {
  if (process.env.DATABASE_URL) return localDatabase(process.env.DATABASE_URL).toString();
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, 'local-postgres.json');
  let state;
  try {
    state = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    state = {
      project: 'blotato-' + randomUUID().slice(0, 12),
      password: randomBytes(24).toString('hex'),
      port: await freePort(),
    };
    // Keep new Docker Desktop databases on the Mac's disk, independent of its VM disk quota.
    if (process.platform === 'darwin') state.hostStorage = true;
    fs.writeFileSync(file, JSON.stringify(state), { flag: 'wx', mode: 0o600 });
  }
  const storage = state.hostStorage ? path.join(directory, 'postgres-data') : 'workspace_data';
  if (state.hostStorage) fs.mkdirSync(storage, { recursive: true, mode: 0o700 });
  await command(
    'docker',
    ['compose', '-p', state.project, '-f', 'compose.workspace.yaml', 'up', '-d', '--wait', '--wait-timeout', '90'],
    {
      env: {
        ...process.env,
        BLOTATO_DB_PASSWORD: state.password,
        BLOTATO_DB_PORT: String(state.port),
        BLOTATO_PG_STORAGE: storage,
      },
    },
  );
  const url = 'postgres://postgres:' + state.password + '@127.0.0.1:' + state.port + '/blotato';
  await waitForPostgres(url);
  return url;
}

module.exports = {
  root,
  delay,
  checkNode,
  command,
  npm,
  freePort,
  installDependencies,
  localDatabase,
  temporaryPostgres,
  workspaceDatabase,
};
