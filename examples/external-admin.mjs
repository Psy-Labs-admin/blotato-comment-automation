// Run from a backend process. Node 24 supplies fetch and AbortSignal.
const key = process.env.BLOTATO_API_KEY;
if (!key) throw new Error('Set BLOTATO_API_KEY to a workspace integration key.');
const base = new URL(process.env.BLOTATO_API_URL || 'http://127.0.0.1:3000/api/v1');
if (
  base.username ||
  base.password ||
  base.search ||
  base.hash ||
  !(
    base.protocol === 'https:' ||
    (base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname))
  )
) {
  throw new Error('BLOTATO_API_URL must use public HTTPS or local HTTP without embedded credentials.');
}

async function api(path, init = {}) {
  const response = await fetch(base.href.replace(/\/$/, '') + path, {
    ...init,
    headers: { authorization: 'Bearer ' + key, ...(init.body ? { 'content-type': 'application/json' } : {}) },
    redirect: 'error',
    signal: AbortSignal.timeout(10000),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${body.code || body.error}`);
  return body;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--create-draft' || !args[1].trim())) {
    throw new Error('Usage: node examples/external-admin.mjs [--create-draft "Your rule name"]');
  }
  const workspace = await api('/workspace');
  const { accounts } = await api('/accounts');
  const { runs } = await api('/runs?limit=5');
  const { leads, nextCursor } = await api('/leads?limit=25');
  console.log(
    JSON.stringify(
      {
        workspace,
        connectedAccountRecords: accounts.length,
        recentRuns: runs.map(({ id, status }) => ({ id, status })),
        leadsOnFirstPage: leads.length,
        hasMoreLeads: nextCursor !== null,
      },
      null,
      2,
    ),
  );
  if (args.length) {
    const { draft } = await api('/drafts', { method: 'POST', body: JSON.stringify({ name: args[1] }) });
    console.log(JSON.stringify({ draftId: draft.id, revision: draft.revision, status: draft.status }));
  }
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
