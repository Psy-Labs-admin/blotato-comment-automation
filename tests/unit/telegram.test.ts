import { afterEach, describe, expect, it, vi } from 'vitest';
import { TelegramNotifier, HttpAlertSink, telegramChannelKey, webhookChannelKey } from '../../src/adapters/alerts';
import { checkTelegram } from '../../src/alerts/check';
import { formatIncident } from '../../src/alerts/format';
import { startServer, sendJson, type FakeServer } from '../fixtures/providers/http';

describe('Telegram Bot API contract (loopback only)', () => {
  let server: FakeServer;
  afterEach(async () => server?.close());
  it('checks bot and chat without sending and validates a send receipt', async () => {
    const methods: string[] = [];
    server = await startServer((_req, res, body, url) => {
      const method = url.pathname.split('/').at(-1)!;
      methods.push(method);
      if (method === 'getMe') return sendJson(res, 200, { ok: true, result: { id: 1, is_bot: true } });
      if (method === 'getChat') return sendJson(res, 200, { ok: true, result: { id: -2, type: 'supergroup' } });
      expect(body).toMatchObject({ chat_id: '-2', text: 'Check', link_preview_options: { is_disabled: true } });
      sendJson(res, 200, { ok: true, result: { message_id: 3, chat: { id: -2 } } });
    });
    const notifier = new TelegramNotifier('test:token', '-2', server.url);
    expect(await notifier.check()).toEqual({
      botAuthenticated: true,
      chatAccessible: true,
      deliveryTested: false,
    });
    expect(methods).toEqual(['getMe', 'getChat']);
    expect(await notifier.notify('Check')).toEqual({ providerMessageId: '3' });
  });
  it.each([
    [
      200,
      { ok: false, error_code: 403, description: 'secret@example.com test:token' },
      'telegram_chat_forbidden',
      { permanent: true },
    ],
    [
      200,
      { ok: false, error_code: 429, parameters: { retry_after: 123 } },
      'telegram_rate_limited',
      { retryAfterMs: 123000 },
    ],
    [429, { ok: false, parameters: { retry_after: -1 } }, 'telegram_rate_limited', { retryAfterMs: 60000 }],
    [503, { ok: false, error_code: 401 }, 'telegram_service_unavailable', { uncertain: true }],
    [200, { ok: true, result: {} }, 'telegram_confirmation_invalid', { uncertain: true }],
    [200, {}, 'telegram_response_invalid', { uncertain: true }],
  ])('rejects status %s and envelope %j safely', async (status, body, code, options) => {
    server = await startServer((_req, res) => sendJson(res, status as number, body));
    const notifier = new TelegramNotifier('test:token', '-2', server.url);
    await expect(notifier.notify('Check')).rejects.toMatchObject({ message: code, code, options });
    try {
      await notifier.notify('Check');
    } catch (error) {
      expect(String(error)).not.toContain('test:token');
      expect(String(error)).not.toContain('secret@example.com');
    }
  });
  it('rejects invalid JSON and does not follow redirects carrying credentials', async () => {
    let requests = 0;
    server = await startServer((_req, res) => {
      requests++;
      res.writeHead(302, { location: '/stolen' });
      res.end('not json');
    });
    await expect(new TelegramNotifier('test:token', '-2', server.url).notify('Check')).rejects.toMatchObject({
      code: 'telegram_response_invalid',
    });
    expect(requests).toBe(1);
  });
  it('treats connection loss as unknown and hides request credentials', async () => {
    server = await startServer((req) => {
      req.socket.destroy();
    });
    await expect(new TelegramNotifier('test:token', '-2', server.url).notify('Check')).rejects.toMatchObject({
      message: 'telegram_connection_unknown',
      options: { uncertain: true },
    });
  });
  it('honors a malformed HTTP429 with a conservative flood wait', async () => {
    server = await startServer((_req, res) => {
      res.writeHead(429);
      res.end('bad json');
    });
    await expect(new TelegramNotifier('test:token', '-2', server.url).notify('Check')).rejects.toMatchObject({
      code: 'telegram_rate_limited',
      options: { retryAfterMs: 60000 },
    });
  });
  it('rejects unsafe endpoints before any request', () => {
    expect(() => new TelegramNotifier('test:token', '-2', 'https://example.com')).toThrow(
      'telegram_endpoint_invalid',
    );
  });
});

it('formats only operational identifiers and rejects unsafe console links', () => {
  const text = formatIncident(
    {
      tenant_id: '11111111-1111-1111-1111-111111111111',
      tenant_name: 'person@example.com',
      account: '@private',
      error_class: 'token=secret',
      occurrences: 2,
      affected_runs: [],
      first_seen_at: new Date(0),
    },
    'opened',
    'https://user:password@example.com/console',
  );
  expect(text).toContain('Workspace 11111111');
  for (const value of ['person@example.com', '@private', 'token=secret', 'password'])
    expect(text).not.toContain(value);
});

it('has no egress for an unconfigured explicit check', async () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  try {
    await expect(checkTelegram({})).rejects.toMatchObject({ code: 'telegram_not_configured' });
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});

it('uses actual admin routes, accurate run counts and operator actions', () => {
  const id = '11111111-1111-1111-1111-111111111111';
  for (const error_class of [
    'send_outcome_unknown',
    'connection_unauthorized',
    'crm_delivery_failing',
    'outbox_dead_letter',
  ]) {
    const text = formatIncident(
      { id, error_class, occurrences: 3, affected_runs: [id, id], first_seen_at: new Date(0) },
      'opened',
      'https://example.com/console',
    );
    expect(text).toContain('Affected automation runs: 2');
    expect(text).toContain('https://example.com/console#incident=' + id);
    expect(text).not.toMatch(/GET \/runs|POST \/intents|outbox|Affected conversations/);
  }
  expect(
    formatIncident(
      { error_class: 'other', occurrences: 1, affected_runs: [], first_seen_at: new Date(0) },
      'opened',
      'https://example.com/console',
    ),
  ).toContain('/console#operations');
});

it('keeps destination identity stable through secret rotation, canonicalizes destinations and separates bot/chat/endpoint', () => {
  const original = new TelegramNotifier('12345:old_secret', '-100123').channelKey;
  expect(new TelegramNotifier('12345:new_secret', '-100123').channelKey).toBe(original);
  expect(telegramChannelKey('00012345:rotated', '-000100123')).toBe(original);
  expect(telegramChannelKey('12345:old_secret', '@Operators')).toBe(
    telegramChannelKey('12345:new_secret', '@operators'),
  );
  expect(telegramChannelKey('test:old', '-2')).toBe(telegramChannelKey('test:new', '-2'));
  expect(telegramChannelKey('54321:old_secret', '-100123')).not.toBe(original);
  expect(telegramChannelKey('12345:old_secret', '-100124')).not.toBe(original);
  const hook = new HttpAlertSink('https://EXAMPLE.com:443/ops/', { token: 'old' }).channelKey;
  expect(new HttpAlertSink('https://example.com/ops', { token: 'new' }).channelKey).toBe(hook);
  expect(webhookChannelKey('https://example.com/ops')).toBe(hook);
  expect(webhookChannelKey('https://example.com/elsewhere')).not.toBe(hook);
  expect(webhookChannelKey('https://other.example/ops')).not.toBe(hook);
});
