import { sendJson, startServer } from './http';

export interface FakeAlertSink {
  url: string;
  received(): string[];
  close(): Promise<void>;
}

/** Stand-in for Telegram (or any chat ops channel) when no bot token is configured. */
export async function startFakeAlertSink(port = 0, log = false): Promise<FakeAlertSink> {
  const received: string[] = [];
  const server = await startServer(async (req, res, body, url) => {
    if (url.pathname === '/alerts' && req.method === 'POST') {
      received.push(String(body?.text ?? ''));
      if (log) console.log(`\n[alert-sink] ${body?.text}\n`);
      return sendJson(res, 200, { ok: true });
    }
    if (url.pathname === '/alerts' && req.method === 'GET') return sendJson(res, 200, received);
    return sendJson(res, 404, { error: 'not found' });
  }, port);
  return { url: server.url, received: () => [...received], close: server.close };
}
