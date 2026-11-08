import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { bearerDigest, type ApiAccess } from './access';
import { localRequest } from './loopback';
import { withTx } from '../storage/db';

const cookieName = 'blotato_operator';
const lifetimeSeconds = 8 * 60 * 60;
const nonce = () => randomBytes(32).toString('hex');
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const login = z.object({ token: z.string().min(1).max(1024) });
const ticket = z.object({ ticket: z.string().regex(/^[a-f0-9]{64}$/) });
type Principal = { tenantId: string; credential: string; csrf?: string; sessionHash?: string };

const exchangePage = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign in · Blotato</title><link rel="stylesheet" href="/console.css"><script src="/session/enter.js" defer></script></head><body><main><h1>Sign in</h1><p id="message" role="status">Opening your workspace…</p><a href="/console">Go to sign in</a></main></body></html>`;
const exchangeScript = readFileSync(join(__dirname, '../ui/enter.js'), 'utf8');

/** Browser sessions do not expose the operator bearer token. API clients can continue to use it directly. */
export function registerSessions(app: FastifyInstance, db: Pool, access: ApiAccess, origin?: string) {
  const principals = new WeakMap<FastifyRequest, Principal>();
  const attributes = '; Path=/; HttpOnly; SameSite=Strict' + (origin?.startsWith('https://') ? '; Secure' : '');
  function sameOrigin(req: FastifyRequest) {
    if (!origin) return localRequest(req.headers.host, req.headers.origin);
    return req.headers.host === new URL(origin).host && (!req.headers.origin || req.headers.origin === origin);
  }
  function authorizedDigest(digest?: string): Principal | undefined {
    const tenantId = digest && access.tenants.get(digest);
    return tenantId && digest ? { tenantId, credential: digest } : undefined;
  }
  function tenantOf(req: FastifyRequest, reply: FastifyReply) {
    const principal = principals.get(req);
    if (!principal || (req.headers['x-tenant-id'] && req.headers['x-tenant-id'] !== principal.tenantId)) {
      reply.code(401).send({ error: 'Sign in to your workspace' });
      return undefined;
    }
    return principal.tenantId;
  }

  app.addHook('onRequest', async (req, reply) => {
    const bearer = req.headers.authorization;
    if (bearer) {
      const principal = authorizedDigest(bearerDigest(bearer));
      if (principal) principals.set(req, principal);
      return;
    }
    const value = req.headers.cookie?.split(/;\s*/).find((c) => c.startsWith(cookieName + '='))?.slice(cookieName.length + 1);
    if (!value || !/^[a-f0-9]{64}$/.test(value)) return;
    if (!sameOrigin(req)) return reply.code(403).send({error: 'Invalid request origin'});
    const sessionHash = hash(value);
    const session = (await db.query(
      'SELECT tenant_id, credential_hash, csrf_token FROM operator_sessions WHERE session_hash = $1 AND expires_at > now()', [sessionHash],
    )).rows[0];
    if (!session || access.tenants.get(session.credential_hash) !== session.tenant_id) return;
    const path = req.routeOptions.url;
    const signingIn = req.method === 'POST' && (path === '/session' || path === '/session/exchange');
    if (!['GET','HEAD','OPTIONS'].includes(req.method) && !signingIn && req.headers['x-csrf-token'] !== session.csrf_token) {
      return reply.code(403).send({ error: 'Session verification failed. Reload the page.' });
    }
    principals.set(req, { tenantId: session.tenant_id, credential: session.credential_hash, csrf: session.csrf_token, sessionHash });
  });

  async function openSession(req: FastifyRequest, reply: FastifyReply, supplied?: Principal, ticketHash?: string) {
    if (!sameOrigin(req)) return reply.code(403).send({error: 'Invalid request origin'});
    const value = nonce();
    const csrf = nonce();
    const created = await withTx(db, async (c) => {
      let principal = supplied;
      if (ticketHash) {
        const redeemed = (await c.query(
          'DELETE FROM operator_login_tickets WHERE ticket_hash = $1 AND expires_at > now() RETURNING credential_hash, tenant_id', [ticketHash],
        )).rows[0];
        principal = authorizedDigest(redeemed?.credential_hash);
        if (principal?.tenantId !== redeemed?.tenant_id) return false;
      }
      if (!principal) return false;
      await c.query('DELETE FROM operator_sessions WHERE expires_at <= now() OR session_hash = $1', [principals.get(req)?.sessionHash ?? null]);
      const result = await c.query(
        `INSERT INTO operator_sessions(session_hash,credential_hash,tenant_id,csrf_token,expires_at)
         SELECT $1,$2,id,$4,now()+make_interval(secs => $5) FROM tenants WHERE id = $3`,
        [hash(value), principal.credential, principal.tenantId, csrf, lifetimeSeconds],
      );
      return result.rowCount === 1;
    });
    if (!created) return reply.code(401).send({error: 'Invalid or expired sign-in credentials'});
    reply.header('set-cookie', cookieName + '=' + value + attributes + '; Max-Age=' + lifetimeSeconds);
    return reply.send({csrfToken: csrf});
  }

  app.post('/session', (req, reply) => {
    const parsed = login.safeParse(req.body);
    return openSession(req, reply, authorizedDigest(parsed.success ? hash(parsed.data.token) : undefined));
  });
  app.post('/session/tickets', async (req, reply) => {
    // Minted only by a credential-bearing client, never by an anonymous local web page.
    const principal = authorizedDigest(bearerDigest(req.headers.authorization));
    if (!principal) return reply.code(401).send({error:'An operator token is required'});
    const value = nonce();
    await withTx(db, async c => {
      await c.query('DELETE FROM operator_login_tickets WHERE expires_at <= now()');
      await c.query(
        "INSERT INTO operator_login_tickets VALUES ($1,$2,$3,now()+interval '2 minutes')",
        [hash(value), principal.credential, principal.tenantId],
      );
    });
    return {ticket: value};
  });
  app.post('/session/exchange', (req, reply) => {
    const parsed = ticket.safeParse(req.body);
    return openSession(req, reply, undefined, parsed.success ? hash(parsed.data.ticket) : undefined);
  });
  app.delete('/session', async (req, reply) => {
    const sessionHash = principals.get(req)?.sessionHash;
    if (sessionHash) await db.query('DELETE FROM operator_sessions WHERE session_hash=$1', [sessionHash]);
    reply.header('set-cookie', cookieName + '=' + attributes + '; Max-Age=0');
    return reply.code(204).send();
  });
  app.get('/session/enter', async (_req, reply) => reply
    .header('content-security-policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'")
    .type('text/html').send(exchangePage));
  app.get('/session/enter.js', async (_req, reply) => reply.type('text/javascript').send(exchangeScript));
  return {
    tenantOf,
    csrfFor: (req: FastifyRequest) => principals.get(req)?.csrf ?? null,
    sessionBinding(req: FastifyRequest) {
      const principal = principals.get(req);
      return principal?.sessionHash ? {sessionHash: principal.sessionHash, credentialHash: principal.credential} : undefined;
    },
  };
}
