import { createHash } from 'node:crypto';
import { NotificationError } from '../alerts/errors';

export interface AlertReceipt { providerMessageId?: string }
export interface AlertNotifier {
  readonly channel?: 'telegram' | 'webhook';
  /** Opaque destination identity. Never expose it in the user interface. */
  readonly channelKey?: string;
  notify(text: string): Promise<void | AlertReceipt>;
}

const fingerprint = (value: string) => createHash('sha256').update(value).digest('hex');
const identifier = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value);

/** Stable logical destination: token rotation must retain flood waits and incident context. */
export function telegramChannelKey(token: string, chatId: string): string {
  const prefix = token.split(':', 1)[0];
  // Numeric prefixes are the Bot API bot ID. Named prefixes support isolated test transports.
  const bot = /^\d+$/.test(prefix) ? BigInt(prefix).toString() : prefix;
  const chat = /^-?\d+$/.test(chatId) ? BigInt(chatId).toString() : chatId.toLowerCase();
  return fingerprint(JSON.stringify(['telegram', bot, chat]));
}

function webhookEndpoint(baseUrl: string): string {
  let url: URL;
  try { url = new URL(baseUrl); } catch { throw new NotificationError('alert_webhook_endpoint_invalid', { permanent: true }); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new NotificationError('alert_webhook_endpoint_invalid', { permanent: true });
  }
  url.pathname = url.pathname.replace(/\/+$/, '') + '/alerts';
  return url.toString();
}

export function webhookChannelKey(baseUrl: string): string {
  return fingerprint(JSON.stringify(['webhook', webhookEndpoint(baseUrl)]));
}

/** Telegram Bot API requests are single attempts. The durable relay owns retries and flood waits. */
export class TelegramNotifier implements AlertNotifier {
  readonly channel = 'telegram' as const;
  readonly channelKey: string;
  private readonly base: string;

  constructor(
    private readonly token: string,
    private readonly chatId: string,
    apiBase = 'https://api.telegram.org',
  ) {
    const url = new URL(apiBase);
    const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    if ((url.origin !== 'https://api.telegram.org' && !(local && url.protocol === 'http:')) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
      throw new NotificationError('telegram_endpoint_invalid', { permanent: true });
    }
    if (!token || !chatId || token.length > 1024 || chatId.length > 256 || /\s/.test(token + chatId)) {
      throw new NotificationError('telegram_configuration_invalid', { permanent: true });
    }
    this.base = url.origin;
    this.channelKey = telegramChannelKey(token, chatId);
  }

  private async request(method: 'sendMessage' | 'getMe' | 'getChat', body: Record<string, unknown>): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(`${this.base}/bot${this.token}/${method}`, {
        method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(5_000),
      });
    } catch {
      throw new NotificationError('telegram_connection_unknown', { uncertain: method === 'sendMessage' });
    }
    let envelope: any;
    try { envelope = await response.json(); } catch {
      if (response.status === 429) throw new NotificationError('telegram_rate_limited', { retryAfterMs: 60_000 });
      throw new NotificationError('telegram_response_invalid', { uncertain: method === 'sendMessage' });
    }
    if (response.ok && envelope?.ok === true) return envelope.result;
    const errorCode = Number(envelope?.error_code ?? response.status);
    if (response.status === 429 || errorCode === 429) {
      const seconds = Number(envelope?.parameters?.retry_after);
      const retryAfterMs = Number.isSafeInteger(seconds) && seconds > 0 && seconds <= 30 * 86400 ? seconds * 1000 : 60_000;
      throw new NotificationError('telegram_rate_limited', { retryAfterMs });
    }
    // A response contradicting its HTTP status cannot prove rejection of a send.
    if (response.status >= 500 || (response.status >= 300 && response.status < 400)) {
      throw new NotificationError('telegram_service_unavailable', { uncertain: method === 'sendMessage' });
    }
    if (envelope?.ok === false && [400, 401, 403, 404].includes(errorCode)) {
      const code = errorCode === 401 ? 'telegram_token_rejected' : errorCode === 403 ? 'telegram_chat_forbidden' : 'telegram_request_rejected';
      throw new NotificationError(code, { permanent: true });
    }
    throw new NotificationError('telegram_response_invalid', { uncertain: method === 'sendMessage' });
  }

  async notify(text: string): Promise<AlertReceipt> {
    if (!text || text.length > 4096) throw new NotificationError('telegram_text_invalid', { permanent: true });
    const result: any = await this.request('sendMessage', {
      chat_id: this.chatId, text, link_preview_options: { is_disabled: true },
    });
    if (!identifier(result?.message_id) || !identifier(result?.chat?.id)) {
      throw new NotificationError('telegram_confirmation_invalid', { uncertain: true });
    }
    return { providerMessageId: String(result.message_id) };
  }

  /** Verifies credentials and chat visibility. Sending permission is established by an explicit test. */
  async check(): Promise<{ botAuthenticated: true; chatAccessible: true; deliveryTested: false }> {
    const me: any = await this.request('getMe', {});
    if (!identifier(me?.id) || me?.is_bot !== true) throw new NotificationError('telegram_bot_confirmation_invalid', { permanent: true });
    const chat: any = await this.request('getChat', { chat_id: this.chatId });
    if (!identifier(chat?.id) || !['private', 'group', 'supergroup', 'channel'].includes(chat?.type)) {
      throw new NotificationError('telegram_chat_confirmation_invalid', { permanent: true });
    }
    return { botAuthenticated: true, chatAccessible: true, deliveryTested: false };
  }
}

/** Authenticated operational webhook delivery. */
export class HttpAlertSink implements AlertNotifier {
  readonly channel = 'webhook' as const;
  readonly channelKey: string;
  private readonly endpoint: string;
  constructor(baseUrl: string, private readonly opts: { token?: string } = {}) {
    this.endpoint = webhookEndpoint(baseUrl);
    this.channelKey = webhookChannelKey(baseUrl);
  }

  async notify(text: string): Promise<void> {
    let response: Response;
    try {
      response = await fetch(this.endpoint, {
        method: 'POST', redirect: 'manual',
        headers: { 'content-type': 'application/json', ...(this.opts.token ? { authorization: 'Bearer ' + this.opts.token } : {}) },
        body: JSON.stringify({ text }), signal: AbortSignal.timeout(5_000),
      });
    } catch { throw new NotificationError('alert_webhook_connection_unknown', { uncertain: true }); }
    if (response.status === 429) {
      const seconds = Number(response.headers.get('retry-after'));
      throw new NotificationError('alert_webhook_rate_limited', { retryAfterMs: Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 30 * 86400) * 1000 : 60_000 });
    }
    if (!response.ok) throw new NotificationError('alert_webhook_rejected', { permanent: response.status >= 400 && response.status < 500, uncertain: response.status >= 500 || response.status < 400 });
  }
}
