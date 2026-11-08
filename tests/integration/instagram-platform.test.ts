import { expect, it } from 'vitest';
import { InstagramGraphPlatform } from '../../src/instagram/platform';
import { sendJson, startServer } from '../fixtures/providers/http';

const credentials = async (accountId: string) => ({ token: 'account-private-token', accountId, connectionId: 'connection', tenantId: 'workspace', tokenVersion: 1 });

it('uses native Graph paths and account credentials without sending a fabricated client reference', async () => {
  const calls: Array<{ path: string; authorization?: string; body: unknown; fields: string | null }> = [];
  const server = await startServer((req, res, body, url) => {
    calls.push({ path: url.pathname, authorization: req.headers.authorization, body, fields: url.searchParams.get('fields') });
    return sendJson(res, 200, req.method === 'GET'
      ? { id: 'media', caption: 'Product details', permalink: 'https://www.instagram.com/p/post/', media_type: 'IMAGE' }
      : { message_id: 'provider-message' });
  });
  try {
    const platform = new InstagramGraphPlatform({ graphVersion: 'v26.0', credentials, graphBaseUrl: server.url });
    const common = { accountId: 'account', text: 'Pricing', clientRef: 'internal-intent' };
    await platform.send({ ...common, kind: 'comment_reply', commentId: 'comment' });
    await platform.send({ ...common, kind: 'private_reply', commentId: 'comment' });
    await platform.send({ ...common, kind: 'dm', recipientId: 'participant' });
    expect(await platform.fetchPost('account', 'media')).toMatchObject({ status: 'available', metadata: { mediaType: 'IMAGE' } });
    expect(calls.map((call) => call.path)).toEqual(['/v26.0/comment/replies', '/v26.0/account/messages', '/v26.0/account/messages', '/v26.0/media']);
    expect(calls[0].body).toEqual({ message: 'Pricing' });
    expect(calls[1].body).toEqual({ recipient: { comment_id: 'comment' }, message: { text: 'Pricing' } });
    expect(calls[2].body).toEqual({ recipient: { id: 'participant' }, message: { text: 'Pricing' } });
    expect(calls.every((call) => call.authorization === 'Bearer account-private-token')).toBe(true);
    expect(calls[3].fields).toBe('id,caption,permalink,media_type');
    expect(JSON.stringify(calls)).not.toContain('internal-intent');
    expect('lookupByClientRef' in platform).toBe(false);
  } finally { await server.close(); }
});

it('keeps a lost acknowledgement uncertain and performs exactly one HTTP attempt', async () => {
  let accepted = 0;
  const server = await startServer((_req, res) => { accepted++; res.destroy(); });
  try {
    const platform = new InstagramGraphPlatform({ graphVersion: 'v26.0', credentials, graphBaseUrl: server.url });
    expect(await platform.send({ kind: 'dm', accountId: 'account', recipientId: 'person', text: 'Link', clientRef: 'intent' })).toMatchObject({ status: 'unknown' });
    expect(accepted).toBe(1);
  } finally { await server.close(); }
});

it('does not follow redirects or retry Graph errors and respects an explicit retry delay', async () => {
  const statuses = [307, 500, 429, 401];
  let calls = 0;
  const server = await startServer((_req, res) => {
    const status = statuses[calls++];
    return sendJson(res, status, { error: { code: status === 401 || status === 500 ? 190 : 4 } }, { location: '/must-not-follow', 'retry-after': '12' });
  });
  try {
    const platform = new InstagramGraphPlatform({ graphVersion: 'v26.0', credentials, graphBaseUrl: server.url });
    const request = { kind: 'dm', accountId: 'account', recipientId: 'person', text: 'Link', clientRef: 'intent' } as const;
    expect(await platform.send(request)).toMatchObject({ status: 'unknown', httpStatus: 307 });
    expect(await platform.send(request)).toMatchObject({ status: 'unknown', httpStatus: 500 });
    expect(await platform.send(request)).toMatchObject({ status: 'not_sent', retryAfterMs: 12_000 });
    expect(await platform.send(request)).toMatchObject({ status: 'rejected', code: 'unauthorized' });
    expect(calls).toBe(4);
  } finally { await server.close(); }
});

it('fails before the network when credentials are missing or belong to another account', async () => {
  let calls = 0;
  const request = { kind: 'dm', accountId: 'account', recipientId: 'person', text: 'Link', clientRef: 'intent' } as const;
  const transport: typeof fetch = async () => { calls++; throw new Error(); };
  const missing = new InstagramGraphPlatform({ graphVersion: 'v26.0', fetch: transport, credentials: async () => { throw new Error('database unavailable'); } });
  expect(await missing.send(request)).toMatchObject({ status: 'not_sent', code: 'credentials_unavailable' });
  const wrong = new InstagramGraphPlatform({ graphVersion: 'v26.0', fetch: transport, credentials: () => credentials('other-account') });
  expect(await wrong.send(request)).toMatchObject({ status: 'rejected', code: 'account_mismatch' });
  expect(calls).toBe(0);
});
