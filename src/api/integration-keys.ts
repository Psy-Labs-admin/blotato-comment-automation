import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Db } from '../storage/db';

export type IntegrationIdentity = { tenantId: string; scope: 'read' | 'write' };
const tokenPattern = /^blt_[A-Za-z0-9_-]{43}$/;
export const integrationTokenHash = (token: string): string => createHash('sha256').update(token).digest('hex');

/** Install inside the encapsulated v1 plugin, before its routes. No process-local credential cache. */
export function registerIntegrationAuth(
  app: FastifyInstance,
  db: Db,
): (request: FastifyRequest) => IntegrationIdentity {
  const identities = new WeakMap<FastifyRequest, IntegrationIdentity>();
  app.addHook('onRequest', async (request, reply) => {
    const header = request.headers.authorization;
    const authorizationCount = request.raw.rawHeaders.filter(
      (_, index, headers) => index % 2 === 0 && headers[index].toLowerCase() === 'authorization',
    ).length;
    const match = typeof header === 'string' && authorizationCount <= 1 ? /^Bearer (\S+)$/i.exec(header) : null;
    const token = match?.[1];
    if (!token || !tokenPattern.test(token)) {
      return reply
        .header('WWW-Authenticate', 'Bearer')
        .code(401)
        .send({ error: 'A valid API key is required.', code: 'UNAUTHORIZED' });
    }
    const result = await db.query<{ tenant_id: string; scope: 'read' | 'write' }>(
      'SELECT tenant_id,scope FROM integration_keys WHERE token_hash=$1 AND revoked_at IS NULL',
      [integrationTokenHash(token)],
    );
    const key = result.rows[0];
    if (!key)
      return reply
        .header('WWW-Authenticate', 'Bearer')
        .code(401)
        .send({ error: 'A valid API key is required.', code: 'UNAUTHORIZED' });
    const requestedTenant = request.headers['x-tenant-id'];
    if (
      requestedTenant !== undefined &&
      (typeof requestedTenant !== 'string' || requestedTenant.toLowerCase() !== key.tenant_id.toLowerCase())
    ) {
      return reply
        .code(403)
        .send({ error: 'The tenant header conflicts with the API key.', code: 'TENANT_MISMATCH' });
    }
    if (request.method !== 'GET' && request.method !== 'HEAD' && key.scope !== 'write') {
      return reply
        .code(403)
        .send({ error: 'This operation requires a write API key.', code: 'INSUFFICIENT_SCOPE' });
    }
    identities.set(request, { tenantId: key.tenant_id, scope: key.scope });
  });
  return (request) => {
    const identity = identities.get(request);
    if (!identity) throw new Error('Integration identity requested before authentication.');
    return identity;
  };
}
