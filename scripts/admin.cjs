// Local operator bootstrap. Machine-owned credentials live outside the public application.
const { createHash, randomBytes, randomUUID } = require('node:crypto');
const { mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { parseEnv } = require('node:util');
const { Pool } = require('pg');

const directory = path.resolve(__dirname, '../.local/operator');
const configFile = path.join(directory, 'credentials.json');
const random = () => randomBytes(32).toString('hex');
const hash = (value) => createHash('sha256').update(value).digest('hex');

async function init(name) {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('Set DATABASE_URL to the database allocated to this installation.');
  if (!name?.trim() || name.length > 200) throw new Error('Supply the workspace name after init.');
  const parsed = new URL(databaseUrl);
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || /[\r\n"\\]/.test(databaseUrl)) throw new Error('Invalid PostgreSQL connection URL.');
  const { migrate } = require('../dist/storage/migrate');
  const pool = new Pool({connectionString: databaseUrl, max: 1});
  try {
    await migrate(pool);
    mkdirSync(directory, {recursive:true, mode:0o700});
    let credentials;
    try {
      credentials = JSON.parse(readFileSync(configFile, 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      credentials = { id:randomUUID(), database:hash(databaseUrl), operator:random(), monitor:random(), webhook:random(), provision:random() };
      writeFileSync(configFile, JSON.stringify(credentials), {flag:'wx', mode:0o600});
    }
    if (credentials.database !== hash(databaseUrl)) throw new Error('This installation is already bound to a different database.');
    await pool.query('INSERT INTO tenants(id,name) VALUES ($1,$2) ON CONFLICT(id) DO NOTHING', [credentials.id,name.trim()]);
    const env = [
      'NODE_ENV=production', 'ROLE=api', 'HOST=127.0.0.1', 'PORT=3000', 'DISPATCH_ENABLED=0',
      'DATABASE_URL="' + databaseUrl + '"',
      'TENANT_TOKEN_HASHES=' + JSON.stringify({[credentials.id]:hash(credentials.operator)}),
      'METRICS_TOKEN_HASH=' + hash(credentials.monitor),
      'WEBHOOK_SIGNING_SECRET=' + credentials.webhook,
      'WEBHOOK_PROVISIONING_SECRET=' + credentials.provision,
    ].join('\n') + '\n';
    try { writeFileSync(path.join(directory,'service.env'), env, {flag:'wx', mode:0o600}); }
    catch(err) { if (err.code !== 'EEXIST') throw err; }
    console.log('Workspace is ready. Start the API with node --env-file=.local/operator/service.env dist/main.js');
  } finally { await pool.end(); }
}

async function openConsole() {
  const credentials = JSON.parse(readFileSync(configFile,'utf8'));
  const settings = parseEnv(readFileSync(path.join(directory, 'service.env'), 'utf8'));
  const port = Number(process.env.PORT ?? settings.PORT ?? 3000);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('Invalid local service port');
  if (!settings.DATABASE_URL || hash(settings.DATABASE_URL) !== credentials.database) throw new Error('Unexpected database for this installation.');
  const base = 'http://127.0.0.1:' + port;
  const ticket = random();
  const pool = new Pool({connectionString:settings.DATABASE_URL, max:1});
  try {
    await pool.query('DELETE FROM operator_login_tickets WHERE expires_at<=now()');
    await pool.query(
      "INSERT INTO operator_login_tickets(ticket_hash,credential_hash,tenant_id,expires_at) VALUES ($1,$2,$3,now()+interval '2 minutes')",
      [hash(ticket),hash(credentials.operator),credentials.id]
    );
  } finally { await pool.end(); }
  const url = base + '/session/enter#ticket=' + ticket;
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'rundll32' : 'xdg-open';
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler',url] : [url];
  const child = spawn(command,args,{stdio:'ignore'});
  await new Promise((resolve,reject) => {
    child.once('error',reject);
    child.once('exit',code=>code===0 ? resolve() : reject(new Error('Could not open the browser')));
  });
}

const [action, ...args] = process.argv.slice(2);
if (action === 'init' || action === 'open') {
  (action === 'init' ? init(args.join(' ')) : openConsole()).catch(e=>{console.error(e.message);process.exitCode=1;});
} else {
  console.error('Usage: node scripts/admin.cjs init <workspace name> | open');
  process.exitCode=2;
}
