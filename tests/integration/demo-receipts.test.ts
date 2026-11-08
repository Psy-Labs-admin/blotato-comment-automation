import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it, expect } from 'vitest';
import { startFakeInstagram } from '../fixtures/providers/fake-instagram';
import { startFakeCrm } from '../fixtures/providers/fake-crm';
import { DemoReceipts } from '../fixtures/providers/receipts';
import { HttpInstagramAdapter } from '../../src/adapters/instagram';

it('retains positive provider evidence and idempotent CRM records when the local simulators restart', async () => {
  const filename = join(mkdtempSync(join(tmpdir(), 'blotato-receipts-')), 'receipts.sqlite');
  let store = new DemoReceipts(filename);
  let ig = await startFakeInstagram(0, store);
  let crm = await startFakeCrm(0, store);
  const send = new HttpInstagramAdapter(ig.url);
  const req = { kind: 'dm', accountId: 'local', recipientId: 'test', text: 'Demo link', clientRef: 'intent-1' } as const;
  const accepted = await send.send(req);
  expect(accepted.status).toBe('accepted');
  const lead = { synthetic: true };
  const upsert = (url: string) => fetch(url + '/leads', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'lead-1' }, body: JSON.stringify(lead) });
  expect((await upsert(crm.url)).ok).toBe(true);
  await Promise.all([ig.close(), crm.close()]);
  store.close();
  store = new DemoReceipts(filename);
  ig = await startFakeInstagram(0, store);
  crm = await startFakeCrm(0, store);
  try {
    expect(await new HttpInstagramAdapter(ig.url).lookupByClientRef('local', 'intent-1')).toMatchObject({ found: true });
    expect(crm.records()).toEqual([{ key: 'lead-1', body: lead }]);
    expect((await upsert(crm.url)).ok).toBe(true);
    expect(crm.records()).toHaveLength(1);
  } finally {
    await Promise.all([ig.close(), crm.close()]);
    store.close();
    rmSync(filename);
  }
});
