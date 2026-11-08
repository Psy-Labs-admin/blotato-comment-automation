import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';

/** Public shell only. Every request for customer data uses the API's authentication boundary. */
export function registerConsole(app: FastifyInstance): void {
  const headers = {
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  };
  for (const [path, file, contentType] of [
    ['/console', 'index.html', 'text/html; charset=utf-8'],
    ['/console.js', 'console.js', 'text/javascript; charset=utf-8'],
    ['/console.css', 'console.css', 'text/css; charset=utf-8'],
  ]) {
    const body = readFileSync(join(__dirname, file));
    app.get(path, async (_request, reply) => reply.headers(headers).type(contentType).send(body));
  }
}
