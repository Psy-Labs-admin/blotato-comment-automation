import type { DemoReceipts } from './receipts';
import { sendJson, startServer } from './http';

export interface FakeCrm {
  url: string;
  records(): Array<{ key: string; body: any }>;
  deliveries(): number;
  setDown(down: boolean): void;
  close(): Promise<void>;
}

/** A CRM that upserts by idempotency key and can be switched off to simulate an outage. */
export async function startFakeCrm(port = 0, receipts?: DemoReceipts): Promise<FakeCrm> {
  const records = new Map<string, any>(receipts?.read('crm'));
  let deliveries = 0;
  let down = false;
  const server = await startServer(async (req, res, body, url) => {
    if (url.pathname === '/__control/down' && req.method === 'POST') {
      down = Boolean(body?.down);
      return sendJson(res, 200, { down });
    }
    if (url.pathname === '/__control/records') return sendJson(res, 200, [...records.entries()]);
    if (url.pathname === '/leads' && req.method === 'POST') {
      if (down) return sendJson(res, 503, { error: 'crm unavailable' });
      deliveries += 1;
      const key = String(req.headers['idempotency-key'] ?? '');
      if (!key) return sendJson(res, 400, { error: 'idempotency-key required' });
      receipts?.put('crm', key, body);
      records.set(key, body);
      return sendJson(res, 200, { ok: true });
    }
    return sendJson(res, 404, { error: 'not found' });
  }, port);
  return {
    url: server.url,
    records: () => [...records.entries()].map(([key, body]) => ({ key, body })),
    deliveries: () => deliveries,
    setDown: (d) => {
      down = d;
    },
    close: server.close,
  };
}
