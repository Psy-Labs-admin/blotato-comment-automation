// Exercise the packaged API and PostgreSQL through their normal network and CLI entry points.
const assert = require('node:assert/strict');
const { randomBytes, randomUUID } = require('node:crypto');
const { appendFileSync } = require('node:fs');
const { checkNode, command } = require('../../scripts/local-runtime.cjs');

async function main() {
  checkNode();
  const image = process.argv[2];
  if (!image || process.argv.length !== 3) throw new Error('Usage: node tests/release/rehearse.cjs <local-image>');
  const project = 'blotato-rehearsal-' + randomUUID();
  const env = { ...process.env, REHEARSAL_IMAGE: image, REHEARSAL_DB_PASSWORD: randomBytes(32).toString('hex') };
  const compose = (args, capture = false) => command('docker', [
    'compose', '--project-name', project, '--file', 'tests/release/compose.yaml', ...args,
  ], { env, capture });

  async function apiOrigin() {
    const address = await compose(['port', 'api', '3000'], true);
    assert.match(address, /^127\.0\.0\.1:\d+$/);
    return 'http://' + address;
  }

  try {
    await compose(['up', '--wait', '--wait-timeout', '150']);
    let origin = await apiOrigin();
    const key = await compose(['exec', '-T', 'api', 'env', '-u', 'DATABASE_URL',
      'node', 'scripts/api-key.cjs', 'create', 'Release rehearsal', '--write'], true);
    const headers = { Authorization: 'Bearer ' + key };
    const retryKey = randomUUID();
    const create = (name) => fetch(origin + '/api/v1/drafts', {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json', 'Idempotency-Key': retryKey },
      body: JSON.stringify({ name }),
      signal: AbortSignal.timeout(10000),
    });
    async function read(url) {
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });
      assert.equal(response.status, 200);
      return response.json();
    }
    const ready = await read(origin + '/ready');
    assert.deepEqual(ready, { ok: true, pipeline: 'disabled' });

    const [first, second] = await Promise.all([create('Pricing replies'), create('Pricing replies')]);
    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    const saved = await first.json();
    assert.deepEqual(await second.json(), saved);
    assert.equal(saved.draft.revision, 1);

    const conflict = await create('Changed request');
    assert.equal(conflict.status, 409);
    assert.equal((await conflict.json()).code, 'idempotency_conflict');
    await compose(['restart', 'api']);
    await compose(['up', '--wait', '--wait-timeout', '150']);
    origin = await apiOrigin();
    const replay = await create('Pricing replies');
    assert.equal(replay.status, 201);
    assert.deepEqual(await replay.json(), saved);
    assert.deepEqual((await read(origin + '/api/v1/drafts')).drafts, [saved.draft]);
  } finally {
    await compose(['down', '--volumes']);
  }

  const message = 'Two concurrent requests created one draft. Reusing the key with changed input returned 409. ' +
    'After an API restart, the original request returned the same draft and revision. The temporary API and database were removed.';
  console.log(message);
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, '### Backend release rehearsal\n\n' + message + '\n');
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
