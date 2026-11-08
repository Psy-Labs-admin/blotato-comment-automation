import { loadInstagramConfig, type InstagramConfig } from './instagram/config';
export type Role = 'all' | 'api' | 'worker' | 'relay';

export interface HttpIntegration {
  baseUrl: string;
  token: string;
}

export interface Config {
  role: Role;
  dispatchEnabled: boolean;
  provisioningSecret?: string;
  integrationSettingsUrl?: string;
  port: number;
  host: string;
  databaseUrl: string;
  temporalAddress?: string;
  temporalNamespace: string;
  taskQueue: string;
  inboxRetentionEnabled: boolean;
  inboxRetentionDays: number;
  consoleUrl?: string;
  nativeInstagram?: InstagramConfig;
  instagram?: HttpIntegration;
  crm?: HttpIntegration;
  alertSink?: HttpIntegration;
  telegramBotToken?: string;
  telegramChatId?: string;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(name + ' is required');
  return value;
}

function integration(env: NodeJS.ProcessEnv, prefix: string): HttpIntegration | undefined {
  const base = env[prefix + '_BASE_URL']?.trim();
  const token = env[prefix + '_API_TOKEN']?.trim();
  if (!base && !token) return undefined;
  if (!base || !token) throw new Error(prefix + '_BASE_URL and ' + prefix + '_API_TOKEN must be configured together');
  const url = new URL(base);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error(prefix + '_BASE_URL must be an HTTP(S) integration URL without credentials, query or fragment');
  }
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error(prefix + '_BASE_URL requires HTTPS outside loopback');
  }
  if (token.length < 32 || /\s/.test(token)) throw new Error(prefix + '_API_TOKEN must contain at least 32 characters without whitespace');
  return { baseUrl: url.toString().replace(/\/$/, ''), token };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const role = env.ROLE ?? 'api';
  if (!['all', 'api', 'worker', 'relay'].includes(role)) throw new Error('ROLE must be all, api, worker or relay');
  const port = Number(env.PORT ?? 3000);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
  const days = Number(env.INBOX_RETENTION_DAYS ?? 30);
  if (!Number.isSafeInteger(days) || days < 1 || days > 3650) throw new Error('INBOX_RETENTION_DAYS must be between 1 and 3650');
  const databaseUrl = required(env, 'DATABASE_URL');
  const database = new URL(databaseUrl);
  if (!['postgres:', 'postgresql:'].includes(database.protocol)) throw new Error('DATABASE_URL must be a PostgreSQL connection URL');

  const instagram = integration(env, 'INSTAGRAM');
  const nativeInstagram = loadInstagramConfig(env);
  if (instagram && nativeInstagram) throw new Error('Configure native Instagram Login or an external Instagram integration, not both');
  const crm = integration(env, 'CRM');
  const alertSink = integration(env, 'ALERT_SINK');
  const telegramBotToken = env.TELEGRAM_BOT_TOKEN?.trim() || undefined;
  const telegramChatId = env.TELEGRAM_CHAT_ID?.trim() || undefined;
  if (Boolean(telegramBotToken) !== Boolean(telegramChatId)) throw new Error('Both Telegram settings are required together');
  if (alertSink && telegramBotToken) throw new Error('Configure one alert delivery integration');
  const temporalAddress = env.TEMPORAL_ADDRESS?.trim() || undefined;
  const dispatchEnabled = role === 'all' || (role === 'api' && env.DISPATCH_ENABLED === '1');
  const requiresDispatch = role !== 'api' || dispatchEnabled;
  if (env.DISPATCH_ENABLED && !['0', '1'].includes(env.DISPATCH_ENABLED)) throw new Error('DISPATCH_ENABLED must be 0 or 1');
  const provisioningSecret = env.WEBHOOK_PROVISIONING_SECRET?.trim() || undefined;
  if (provisioningSecret && (provisioningSecret.length < 32 || provisioningSecret === env.WEBHOOK_SIGNING_SECRET)) {
    throw new Error('WEBHOOK_PROVISIONING_SECRET requires at least 32 characters and must be distinct from WEBHOOK_SIGNING_SECRET');
  }
  let integrationSettingsUrl: string | undefined;
  if (env.INSTAGRAM_CONNECT_URL) {
    const connect = new URL(env.INSTAGRAM_CONNECT_URL);
    if (connect.protocol !== 'https:' || connect.username || connect.password) throw new Error('INSTAGRAM_CONNECT_URL must be an HTTPS integration settings URL');
    integrationSettingsUrl = connect.toString();
  }
  if (requiresDispatch && (!temporalAddress || temporalAddress === 'embedded')) throw new Error('TEMPORAL_ADDRESS must identify a running Temporal service');
  if (requiresDispatch && !instagram && !nativeInstagram) throw new Error('Authenticated Instagram Login or an Instagram integration is required for this process role');
  let consoleUrl: string | undefined;
  if (env.CONSOLE_ORIGIN) {
    const origin = new URL(env.CONSOLE_ORIGIN);
    if (origin.protocol !== 'https:' || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/') {
      throw new Error('CONSOLE_ORIGIN must be an HTTPS origin without credentials or a path');
    }
    consoleUrl = origin.origin + '/console';
  }
  if (nativeInstagram) {
    const redirect = new URL(nativeInstagram.redirectUri);
    const local = ['127.0.0.1', 'localhost', '[::1]'].includes(redirect.hostname);
    if (!local && (!consoleUrl || new URL(consoleUrl).origin !== redirect.origin)) {
      throw new Error('Public Instagram Login requires CONSOLE_ORIGIN to match INSTAGRAM_REDIRECT_URI');
    }
  }
  return {
    role: role as Role, dispatchEnabled, provisioningSecret, integrationSettingsUrl, port, databaseUrl, temporalAddress,
    host: env.HOST?.trim() || '127.0.0.1',
    temporalNamespace: env.TEMPORAL_NAMESPACE ?? 'default',
    taskQueue: env.TEMPORAL_TASK_QUEUE ?? 'comment-automations',
    inboxRetentionEnabled: env.INBOX_RETENTION_ENABLED === '1',
    inboxRetentionDays: days,
    consoleUrl, nativeInstagram, instagram, crm, alertSink, telegramBotToken, telegramChatId,
  };
}
