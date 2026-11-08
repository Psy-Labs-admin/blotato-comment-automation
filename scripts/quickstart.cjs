const fs = require('node:fs');
const path = require('node:path');
const { parseEnv } = require('node:util');
const {
  root,
  delay,
  checkNode,
  command,
  npm,
  freePort,
  installDependencies,
  workspaceDatabase,
} = require('./local-runtime.cjs');

async function main() {
  checkNode();
  const flags = process.argv.slice(2);
  if (flags.some((flag) => flag !== '--no-open')) throw new Error('Usage: npm run quickstart -- [--no-open]');
  const local = path.resolve(process.env.BLOTATO_LOCAL_DIR || path.join(root, '.local'));
  fs.mkdirSync(local, { recursive: true, mode: 0o700 });

  await installDependencies();
  await npm(['run', 'build']);
  const settingsFile = path.join(local, 'operator/service.env');
  const saved = fs.existsSync(settingsFile) ? parseEnv(fs.readFileSync(settingsFile, 'utf8')) : undefined;
  if (saved && process.env.DATABASE_URL && saved.DATABASE_URL !== process.env.DATABASE_URL)
    throw new Error('This checkout already has a workspace bound to another database.');
  let databaseUrl;
  if (saved && !fs.existsSync(path.join(local, 'local-postgres.json'))) databaseUrl = saved.DATABASE_URL;
  else databaseUrl = await workspaceDatabase(local);

  let port = Number(process.env.PORT || saved?.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
  try {
    await freePort(port);
  } catch (err) {
    if (err.code !== 'EADDRINUSE' || process.env.PORT || saved)
      throw new Error('Port ' + port + ' is unavailable. Open the running workspace, or set PORT to a free port.');
    port = await freePort();
  }
  const env = { ...process.env, PORT: String(port), BLOTATO_LOCAL_DIR: local };
  if (!saved)
    await command(process.execPath, ['scripts/admin.cjs', 'init', process.env.WORKSPACE_NAME || 'Blotato'], {
      env: { ...env, DATABASE_URL: databaseUrl },
    });

  // The explicit installation file is authoritative; quickstart never borrows provider credentials from a developer shell.
  const serviceEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    SystemRoot: process.env.SystemRoot,
    PORT: String(port),
  };
  let child;
  const stop = () => child?.kill('SIGTERM');
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  const running = command(process.execPath, ['--env-file=' + settingsFile, 'dist/main.js'], {
    env: serviceEnv,
    handle: (c) => {
      child = c;
    },
  });
  // Observe early startup failures while the health probe is running.
  running.catch(() => {});
  try {
    let ready = false;
    for (let i = 0; i < 60 && child.exitCode === null; i++) {
      try {
        ready = (await fetch('http://127.0.0.1:' + port + '/health', { signal: AbortSignal.timeout(1000) })).ok;
      } catch {}
      if (ready) break;
      await delay(250);
    }
    if (!ready) throw new Error('The workspace API did not start.');
    console.log('Workspace: http://127.0.0.1:' + port + '/console');
    if (!flags.includes('--no-open')) await command(process.execPath, ['scripts/admin.cjs', 'open'], { env });
    await running;
  } finally {
    stop();
    await running.catch(() => {});
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}
main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
