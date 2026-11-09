// Machine-key administration runs on the trusted operator's machine, never in the UI.
const { createHash, randomBytes } = require('node:crypto');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { parseEnv } = require('node:util');
const { Pool } = require('pg');
class InputError extends Error {}
const hash = (value) => createHash('sha256').update(value).digest('hex');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function environment() {
  const explicitDatabase = process.env.DATABASE_URL;
  const explicitTenant = process.env.BLOTATO_TENANT_ID;
  if (explicitDatabase || explicitTenant) {
    if (!explicitDatabase || !explicitTenant)
      throw new InputError('Set DATABASE_URL and BLOTATO_TENANT_ID together to select an explicit environment.');
    if (!uuid.test(explicitTenant)) throw new InputError('BLOTATO_TENANT_ID must be a UUID.');
    return { databaseUrl: explicitDatabase, tenantId: explicitTenant };
  }
  const local = path.resolve(process.env.BLOTATO_LOCAL_DIR || path.resolve(__dirname, '../.local'), 'operator');
  let credentials, settings;
  try {
    credentials = JSON.parse(readFileSync(path.join(local, 'credentials.json'), 'utf8'));
    settings = parseEnv(readFileSync(path.join(local, 'service.env'), 'utf8'));
  } catch {
    throw new InputError(
      'Local installation not found. Run quickstart, or set DATABASE_URL and BLOTATO_TENANT_ID together.',
    );
  }
  if (!settings.DATABASE_URL || hash(settings.DATABASE_URL) !== credentials.database || !uuid.test(credentials.id))
    throw new InputError('Unexpected database or tenant binding for this installation.');
  return { databaseUrl: settings.DATABASE_URL, tenantId: credentials.id };
}

async function main() {
  if (Number(process.versions.node.split('.')[0]) < 24) throw new InputError('Node 24 or later is required.');
  const [action, ...args] = process.argv.slice(2);
  if (!['create', 'list', 'revoke'].includes(action))
    throw new InputError('Usage: api:key create <name> [--write] | list | revoke <uuid>');
  const write = args.at(-1) === '--write';
  const name = args[0];
  if (
    action === 'create' &&
    (args.length !== (write ? 2 : 1) || !name?.trim() || name.trim().length > 200 || name.startsWith('--'))
  )
    throw new InputError('Usage: api:key create <name> [--write] (name: 1 to 200 characters)');
  if (action === 'list' && args.length) throw new InputError('Usage: api:key list');
  if (action === 'revoke' && (args.length !== 1 || !uuid.test(args[0])))
    throw new InputError('Usage: api:key revoke <uuid>');
  const { databaseUrl, tenantId } = environment();
  const db = new Pool({ connectionString: databaseUrl, max: 1 });
  try {
    if (!(await db.query('SELECT 1 FROM tenants WHERE id=$1', [tenantId])).rowCount)
      throw new InputError('The selected tenant does not exist.');
    if (action === 'create') {
      const token = 'blt_' + randomBytes(32).toString('base64url');
      const scope = write ? 'write' : 'read';
      const result = await db.query(
        'INSERT INTO integration_keys(tenant_id,name,scope,token_hash) VALUES ($1,$2,$3,$4) RETURNING id',
        [tenantId, name.trim(), scope, hash(token)],
      );
      console.error(
        'Created API key ' + result.rows[0].id + ' (' + scope + '). Store the token now; it cannot be recovered.',
      );
      process.stdout.write(token + '\n');
    } else if (action === 'list') {
      const result = await db.query(
        "SELECT id,name,scope,CASE WHEN revoked_at IS NULL THEN 'active' ELSE 'revoked' END AS status FROM integration_keys WHERE tenant_id=$1 ORDER BY created_at,id",
        [tenantId],
      );
      process.stdout.write(JSON.stringify(result.rows, null, 2) + '\n');
    } else {
      const result = await db.query(
        'UPDATE integration_keys SET revoked_at=COALESCE(revoked_at,now()) WHERE id=$1 AND tenant_id=$2 RETURNING id',
        [args[0], tenantId],
      );
      if (!result.rowCount) throw new InputError('API key not found for this tenant.');
      console.error('Revoked API key ' + result.rows[0].id + '.');
    }
  } finally {
    await db.end();
  }
}
main().catch((error) => {
  console.error(
    error instanceof InputError
      ? error.message
      : 'API key operation failed. Check database availability and applied migrations.',
  );
  process.exitCode = 1;
});
