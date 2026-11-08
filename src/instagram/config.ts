import { z } from 'zod';
import type { Capabilities } from '../domain/types';

export const INSTAGRAM_SCOPES = [
  'instagram_business_basic',
  'instagram_business_manage_comments',
  'instagram_business_manage_messages',
] as const;

export interface InstagramConfig {
  appId: string;
  appSecret: string;
  redirectUri: string;
  encryptionKey: Buffer;
  graphVersion: string;
  webhookVerifyToken: string;
  webhookAppSecret: string;
  capabilities: Capabilities;
}

const capabilitiesSchema = z.object({
  privateReplyWindowHours: z.number().positive().max(168),
  messagingWindowHours: z.number().positive().max(24),
  sendsPerWindow: z.number().int().positive(),
  budgetWindowSeconds: z.number().positive(),
  recipientHourlyLimit: z.number().int().positive(),
  reconciliation: z.literal('none'),
}).strict();

/** Instagram product credentials are distinct from the Meta app secret used for webhook signatures. */
export function loadInstagramConfig(env: NodeJS.ProcessEnv = process.env): InstagramConfig | undefined {
  const fields = ['INSTAGRAM_APP_ID', 'INSTAGRAM_APP_SECRET', 'INSTAGRAM_REDIRECT_URI', 'INSTAGRAM_TOKEN_ENCRYPTION_KEY',
    'INSTAGRAM_GRAPH_VERSION', 'INSTAGRAM_WEBHOOK_VERIFY_TOKEN', 'INSTAGRAM_CAPABILITIES_JSON'];
  if (!fields.some((name) => env[name]?.trim())) return undefined;
  const required = (name: string) => {
    const value = env[name]?.trim();
    if (!value) throw new Error(name + ' is required for Instagram Login');
    return value;
  };
  const appId = required('INSTAGRAM_APP_ID');
  if (!/^\d+$/.test(appId)) throw new Error('INSTAGRAM_APP_ID must be the Instagram product app ID');
  const appSecret = required('INSTAGRAM_APP_SECRET');
  const webhookAppSecret = required('META_APP_SECRET');
  if (appSecret.length < 16 || webhookAppSecret.length < 16) throw new Error('Instagram and Meta app secrets must be configured securely');
  const redirect = new URL(required('INSTAGRAM_REDIRECT_URI'));
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(redirect.hostname);
  if ((redirect.protocol !== 'https:' && !(redirect.protocol === 'http:' && loopback)) || redirect.username || redirect.password || redirect.search || redirect.hash || redirect.pathname !== '/integrations/instagram/callback') {
    throw new Error('INSTAGRAM_REDIRECT_URI must be the registered HTTPS Instagram callback URL');
  }
  const encodedKey = required('INSTAGRAM_TOKEN_ENCRYPTION_KEY');
  const encryptionKey = Buffer.from(encodedKey, 'base64');
  if (encryptionKey.length !== 32 || encryptionKey.toString('base64') !== encodedKey) throw new Error('INSTAGRAM_TOKEN_ENCRYPTION_KEY must be a base64-encoded 32-byte key');
  const graphVersion = required('INSTAGRAM_GRAPH_VERSION');
  if (!/^v\d{2}\.0$/.test(graphVersion)) throw new Error('INSTAGRAM_GRAPH_VERSION must name the configured Meta API version');
  const webhookVerifyToken = required('INSTAGRAM_WEBHOOK_VERIFY_TOKEN');
  if (webhookVerifyToken.length < 16) throw new Error('INSTAGRAM_WEBHOOK_VERIFY_TOKEN must contain at least 16 characters');
  let raw: unknown;
  try { raw = JSON.parse(required('INSTAGRAM_CAPABILITIES_JSON')); } catch { throw new Error('INSTAGRAM_CAPABILITIES_JSON must be valid JSON'); }
  const parsed = capabilitiesSchema.safeParse(raw);
  if (!parsed.success) throw new Error('Configure explicit Instagram messaging windows and send budgets with reconciliation none');
  return { appId, appSecret, redirectUri: redirect.toString(), encryptionKey, graphVersion, webhookVerifyToken, webhookAppSecret, capabilities: parsed.data };
}
