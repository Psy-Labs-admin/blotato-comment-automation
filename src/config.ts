export type Role = 'all' | 'api' | 'worker' | 'relay';

export interface Config {
  role: Role;
  port: number;
  databaseUrl: string;
  temporalAddress: string;
  temporalNamespace: string;
  taskQueue: string;
  fakes: boolean;
  instagramBaseUrl: string;
  crmBaseUrl: string;
  alertSinkUrl: string;
  telegramBotToken?: string;
  telegramChatId?: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    role: (env.ROLE as Role) ?? 'all',
    port: Number(env.PORT ?? 3000),
    databaseUrl: env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:55432/blotato',
    temporalAddress: env.TEMPORAL_ADDRESS ?? 'localhost:7233',
    temporalNamespace: env.TEMPORAL_NAMESPACE ?? 'default',
    taskQueue: env.TEMPORAL_TASK_QUEUE ?? 'comment-automations',
    fakes: env.FAKES === '1',
    instagramBaseUrl: env.INSTAGRAM_BASE_URL ?? 'http://localhost:4001',
    crmBaseUrl: env.CRM_BASE_URL ?? 'http://localhost:4002',
    alertSinkUrl: env.ALERT_SINK_URL ?? 'http://localhost:4003',
    telegramBotToken: env.TELEGRAM_BOT_TOKEN || undefined,
    telegramChatId: env.TELEGRAM_CHAT_ID || undefined,
  };
}
