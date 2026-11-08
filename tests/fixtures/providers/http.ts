import { localRequest } from '../../../src/api/loopback';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeServer {
  url: string;
  close(): Promise<void>;
}

export type Handler = (req: IncomingMessage, res: ServerResponse, body: any, url: URL) => void | Promise<void>;

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

/** Minimal JSON HTTP server used by the fakes (real sockets so faults are real network events). */
export async function startServer(handler: Handler, port = 0): Promise<FakeServer> {
  const server = http.createServer((req, res) => {
    if (!localRequest(req.headers.host, req.headers.origin)) return sendJson(res, 403, { error: 'Local requests only' });
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body: any = undefined;
      try {
        body = raw ? JSON.parse(raw) : undefined;
      } catch {
        return sendJson(res, 400, { error: { message: 'invalid json' } });
      }
      try {
        await handler(req, res, body, new URL(req.url ?? '/', 'http://fake'));
      } catch (err) {
        if (!res.headersSent) sendJson(res, 500, { error: { message: String(err) } });
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  const { port: actual } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${actual}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
