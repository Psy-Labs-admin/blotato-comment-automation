import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

export interface ApiAccess {
  tenants: ReadonlyMap<string, string>;
  metricsDigest: string;
  webhookSecret: string;
}

const digest = z.string().regex(/^[0-9a-f]{64}$/);

/** Only hashes of operator and monitoring tokens need to be stored on the API host. */
export function loadAccess(env: NodeJS.ProcessEnv): ApiAccess {
  let configured: unknown;
  try {
    configured = JSON.parse(env.TENANT_TOKEN_HASHES ?? '');
  } catch {
    throw new Error('TENANT_TOKEN_HASHES must map tenant UUIDs to SHA-256 digests');
  }
  const parsed = z.record(z.string().uuid(), digest).safeParse(configured);
  const tenants = new Map<string, string>();
  if (!parsed.success || !Object.keys(parsed.data).length) throw new Error('Invalid TENANT_TOKEN_HASHES');
  for (const [tenant, hash] of Object.entries(parsed.data)) {
    if (tenants.has(hash)) throw new Error('Each tenant needs a distinct token');
    tenants.set(hash, tenant.toLowerCase());
  }
  const metricsDigest = env.METRICS_TOKEN_HASH ?? '';
  const webhookSecret = env.WEBHOOK_SIGNING_SECRET ?? '';
  if (!digest.safeParse(metricsDigest).success || tenants.has(metricsDigest)) throw new Error('A distinct METRICS_TOKEN_HASH is required');
  if (Buffer.byteLength(webhookSecret) < 32) throw new Error('WEBHOOK_SIGNING_SECRET must contain at least 32 bytes');
  return { tenants, metricsDigest, webhookSecret };
}

export function bearerDigest(header: string | undefined): string | undefined {
  const match = /^Bearer ([^\s]+)$/i.exec(header ?? '');
  return match ? createHash('sha256').update(match[1]).digest('hex') : undefined;
}

/** Signature of the existing integration's normalized envelope, including the delivery timestamp. */
export function validWebhook(raw: Buffer, timestamp: unknown, signature: unknown, secret: string, now: Date): boolean {
  if (typeof timestamp !== 'string' || !/^\d{10}$/.test(timestamp)) return false;
  if (Math.abs(now.getTime() / 1000 - Number(timestamp)) > 300) return false;
  if (typeof signature !== 'string' || !/^sha256=[0-9a-f]{64}$/.test(signature)) return false;
  const expected = createHmac('sha256', secret).update(timestamp).update('.').update(raw).digest();
  return timingSafeEqual(expected, Buffer.from(signature.slice(7), 'hex'));
}
