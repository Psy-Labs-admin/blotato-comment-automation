import { expect, it } from 'vitest';
import { loadConfig } from '../../src/config';

it('pins all demo delivery to the local simulators, including when external credentials were inherited', () => {
  const cfg = loadConfig({
    FAKES: '1', INSTAGRAM_BASE_URL: 'https://ig.example', CRM_BASE_URL: 'https://crm.example',
    ALERT_SINK_URL: 'https://alerts.example', TELEGRAM_BOT_TOKEN: 'inherited', TELEGRAM_CHAT_ID: '12345',
  });
  expect([cfg.instagramBaseUrl, cfg.crmBaseUrl, cfg.alertSinkUrl]).toEqual([
    'http://127.0.0.1:4001', 'http://127.0.0.1:4002', 'http://127.0.0.1:4003',
  ]);
  expect(cfg.telegramBotToken).toBeUndefined();
  expect(cfg.telegramChatId).toBeUndefined();
});
