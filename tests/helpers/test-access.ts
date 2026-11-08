import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { loadAccess } from '../../src/api/access';

/** Uses the same bearer verification and exact-byte HMAC contract as the deployed API. */
export function createTestAccess() {
  const initialTenant = randomUUID();
  const token = randomBytes(32).toString('hex');
  const monitorToken = randomBytes(32).toString('hex');
  const provisioningSecret = randomBytes(32).toString('hex');
  const webhookSecret = randomBytes(32).toString('hex');
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  const initial = loadAccess({
    TENANT_TOKEN_HASHES: JSON.stringify({ [initialTenant]: hash(token) }),
    METRICS_TOKEN_HASH: hash(monitorToken),
    WEBHOOK_SIGNING_SECRET: webhookSecret,
  });
  const tenants = new Map(initial.tenants);
  const tokens = new Map<string, string>([[initialTenant, token]]);
  const access = { ...initial, tenants };
  function operatorHeaders(tenantId: string): Record<string, string> {
    let operatorToken = tokens.get(tenantId);
    if (!operatorToken) {
      operatorToken = randomBytes(32).toString('hex');
      tokens.set(tenantId, operatorToken);
      tenants.set(hash(operatorToken), tenantId);
    }
    return { authorization: 'Bearer ' + operatorToken };
  }
  function webhookHeaders(raw: string, timestamp = String(Math.floor(Date.now() / 1000))): Record<string, string> {
    return {
      'content-type': 'application/json',
      'x-webhook-timestamp': timestamp,
      'x-webhook-signature': 'sha256=' + createHmac('sha256', webhookSecret).update(timestamp + '.' + raw).digest('hex'),
    };
  }
  function signedWebhook(payload: unknown) {
    const raw = typeof payload === 'string' ? payload : JSON.stringify(payload);
    return { payload: raw, headers: webhookHeaders(raw) };
  }
  return {
    access, operatorHeaders, webhookHeaders, signedWebhook, webhookSecret, provisioningSecret,
    signedIntegration(payload: unknown) {
      const raw = JSON.stringify(payload);
      const timestamp = String(Math.floor(Date.now() / 1000));
      return { payload: raw, headers: {
        'content-type': 'application/json', 'x-integration-timestamp': timestamp,
        'x-integration-signature': 'sha256=' + createHmac('sha256', provisioningSecret).update(timestamp + '.' + raw).digest('hex'),
      } };
    },
    metricsHeaders: { authorization: 'Bearer ' + monitorToken },
  };
}
