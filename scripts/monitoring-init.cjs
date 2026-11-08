// Prepare the metrics credential for a locally bootstrapped workspace.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { parseEnv } = require('node:util');

function main() {
  const local = path.resolve(process.env.BLOTATO_LOCAL_DIR || path.join(__dirname, '../.local'));
  const directory = path.join(local, 'monitoring');
  const existing = path.join(local, 'operator');
  const credentials = JSON.parse(fs.readFileSync(path.join(existing, 'credentials.json'), 'utf8'));
  const config = parseEnv(fs.readFileSync(path.join(existing, 'service.env'), 'utf8'));
  if (
    !credentials.monitor ||
    createHash('sha256').update(credentials.monitor).digest('hex') !== config.METRICS_TOKEN_HASH
  ) {
    throw new Error('The monitoring credential does not match the workspace configuration.');
  }
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  const token = path.join(directory, 'metrics.token');
  try {
    fs.writeFileSync(token, credentials.monitor, { mode: 0o644, flag: 'wx' });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (fs.readFileSync(token, 'utf8').trim() !== credentials.monitor)
      throw new Error('A different monitoring credential already exists.');
  }
  // Compose bind mounts the file for Prometheus running as nobody. The parent is owner-only.
  fs.chmodSync(token, 0o644);
  console.log('Metrics credential ready in ' + directory + '. Start Prometheus with compose.monitoring.yaml.');
}
try {
  main();
} catch (error) {
  console.error(error.code === 'ENOENT' ? 'Start the workspace with npm run quickstart first.' : error.message);
  process.exitCode = 1;
}
