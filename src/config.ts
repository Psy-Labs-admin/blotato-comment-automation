export type Role = 'all' | 'api' | 'worker' | 'relay';

export interface Config {
  role: Role;
  port: number;
  databaseUrl: string;
  temporalAddress: string;
  temporalNamespace: string;
  taskQueue: string;
  fakes: boolean;
  inboxRetentionEnabled: boolean;
  inboxRetentionDays: number;
  consoleUrl?: string;
  instagramBaseUrl: string;
  crmBaseUrl: string;
  alertSinkUrl: string;
  telegramBotToken?: string;
  telegramChatId?: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const role = env.ROLE ?? 'all';
  if (!['all', 'api', 'worker', 'relay'].includes(role)) throw new Error('ROLE must be all, api, worker or relay');
  const fakes = env.FAKES === '1';
  if (!fakes && Boolean(env.TELEGRAM_BOT_TOKEN) !== Boolean(env.TELEGRAM_CHAT_ID)) throw new Error('Both Telegram settings are required together');
  const days = Number(env.INBOX_RETENTION_DAYS ?? 30);
  if (!Number.isSafeInteger(days) || days < 1 || days > 3650) throw new Error('INBOX_RETENTION_DAYS must be between 1 and 3650');
  const port = Number(env.PORT ?? 3000);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
  let consoleUrl: string | undefined;
  if (fakes) consoleUrl = 'http://127.0.0.1:' + port + '/console';
  else if (env.CONSOLE_ORIGIN) {
    const origin = new URL(env.CONSOLE_ORIGIN);
    if (origin.protocol !== 'https:' || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/') {
      throw new Error('CONSOLE_ORIGIN must be an HTTPS origin without credentials or a path');
    }
    consoleUrl = origin.origin + '/console';
  }
  return {
    role: role as Role,
    port, consoleUrl,
    databaseUrl: env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:55432/blotato',
    temporalAddress: env.TEMPORAL_ADDRESS ?? 'localhost:7233',
    temporalNamespace: env.TEMPORAL_NAMESPACE ?? 'default',
    taskQueue: env.TEMPORAL_TASK_QUEUE ?? 'comment-automations',
    fakes,
    inboxRetentionEnabled: env.INBOX_RETENTION_ENABLED === '1',
    inboxRetentionDays: days,
    instagramBaseUrl: fakes ? 'http://127.0.0.1:4001' : env.INSTAGRAM_BASE_URL ?? 'http://localhost:4001',
    crmBaseUrl: fakes ? 'http://127.0.0.1:4002' : env.CRM_BASE_URL ?? 'http://localhost:4002',
    alertSinkUrl: fakes ? 'http://127.0.0.1:4003' : env.ALERT_SINK_URL ?? 'http://localhost:4003',
    telegramBotToken: fakes ? undefined : env.TELEGRAM_BOT_TOKEN || undefined,
    telegramChatId: fakes ? undefined : env.TELEGRAM_CHAT_ID || undefined,
  };
}
