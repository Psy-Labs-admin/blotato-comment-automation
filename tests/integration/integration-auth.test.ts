import { expect, it } from 'vitest';
import { HttpInstagramAdapter } from '../../src/adapters/instagram';
import { HttpCrmClient } from '../../src/adapters/crm';
import { HttpAlertSink } from '../../src/adapters/alerts';
import { HttpMetadataClient } from '../../src/metadata/client';
import { sendJson, startServer } from '../fixtures/providers/http';

it('authenticates every operation on the configured integration boundary', async () => {
  const token = 'test-integration-credential-with-32-characters';
  const requests: Array<{ path: string; authorization: string | undefined }> = [];
  const server = await startServer((req, res, _body, url) => {
    requests.push({ path: url.pathname, authorization: req.headers.authorization });
    if (url.pathname.endsWith('/media/post')) return sendJson(res, 200, { mediaType: 'IMAGE' });
    if (req.method === 'GET') return sendJson(res, 200, { data: [{ id: 'provider-message' }] });
    return sendJson(res, 200, { message_id: 'provider-message' });
  });
  try {
    const platform = new HttpInstagramAdapter(server.url, { timeoutMs: 1_000, token });
    await platform.send({ kind: 'dm', accountId: 'account', recipientId: 'participant', text: 'Hello', clientRef: 'intent' });
    await platform.lookupByClientRef('account', 'intent');
    await new HttpMetadataClient(server.url, 1_000, token).fetchPost('account', 'post');
    await new HttpCrmClient(server.url, { token }).upsertLead({
      eventId: 'event', leadId: 'lead', tenantId: 'tenant', email: 'person@example.com',
      source: { runId: 'run', commentId: null, mediaId: 'post' },
    }, 'event');
    await new HttpAlertSink(server.url, { token }).notify('Operational incident');
    expect(requests).toHaveLength(5);
    expect(requests.every((r) => r.authorization === 'Bearer ' + token)).toBe(true);
  } finally {
    await server.close();
  }
});
