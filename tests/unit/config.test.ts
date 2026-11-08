import { expect, it } from 'vitest';
import { loadConfig } from '../../src/config';

const database = { DATABASE_URL: 'postgres://app:password@localhost/application' };
const integration = { INSTAGRAM_BASE_URL: 'https://instagram-integration.example', INSTAGRAM_API_TOKEN: 'a'.repeat(40) };

it('starts an unconnected API without a Temporal service or populated integrations', () => {
  const cfg = loadConfig(database);
  expect(cfg.role).toBe('api');
  expect(cfg.temporalAddress).toBeUndefined();
  expect(cfg.instagram).toBeUndefined();
  expect(cfg.crm).toBeUndefined();
  expect(cfg.alertSink).toBeUndefined();
});

it('requires explicit endpoints and credentials before a worker can dispatch', () => {
  expect(() => loadConfig({ ...database, ROLE: 'worker' })).toThrow('TEMPORAL_ADDRESS');
  expect(() => loadConfig({ ...database, ROLE: 'worker', TEMPORAL_ADDRESS: 'localhost:7233' })).toThrow('Instagram');
  expect(() => loadConfig({ ...database, ...integration, ROLE: 'worker', TEMPORAL_ADDRESS: 'localhost:7233' })).not.toThrow();
});

it('rejects incomplete credentials, external plaintext transport and URL-embedded credentials', () => {
  expect(() => loadConfig({ ...database, INSTAGRAM_BASE_URL: integration.INSTAGRAM_BASE_URL })).toThrow('configured together');
  expect(() => loadConfig({ ...database, ...integration, INSTAGRAM_BASE_URL: 'http://integration.example' })).toThrow('HTTPS');
  expect(() => loadConfig({ ...database, ...integration, INSTAGRAM_BASE_URL: 'https://user:password@integration.example' })).toThrow('without credentials');
});

it('starts Instagram relays independently of optional CRM and alert delivery', () => {
  expect(() => loadConfig({ ...database, ...integration, ROLE: 'relay', TEMPORAL_ADDRESS: 'localhost:7233' })).not.toThrow();
  expect(() => loadConfig({ ...database, ...integration, ROLE: 'relay', TEMPORAL_ADDRESS: 'embedded' })).toThrow('running Temporal');
});

it('requires an explicit PostgreSQL database and accepts only PostgreSQL URLs', () => {
  expect(() => loadConfig({})).toThrow('DATABASE_URL');
  expect(() => loadConfig({ DATABASE_URL: 'https://example.com' })).toThrow('PostgreSQL');
});

it('requires configured workers and integrations before enabling dispatch on a standalone API', () => {
  expect(() => loadConfig({ ...database, DISPATCH_ENABLED: '1' })).toThrow('TEMPORAL_ADDRESS');
  expect(() => loadConfig({ ...database, WEBHOOK_PROVISIONING_SECRET: 'short' })).toThrow('WEBHOOK_PROVISIONING_SECRET');
  expect(() => loadConfig({ ...database, INSTAGRAM_CONNECT_URL: 'http://settings.example/connect' })).toThrow('HTTPS');
  expect(loadConfig({ ...database }).dispatchEnabled).toBe(false);
});

it('binds a public native OAuth callback to the operator console origin and keeps CRM optional', () => {
  const native = {
    ...database,
    INSTAGRAM_APP_ID: '123456789',
    INSTAGRAM_APP_SECRET: 'instagram-product-secret',
    META_APP_SECRET: 'meta-webhook-secret',
    INSTAGRAM_REDIRECT_URI: 'https://operator.example/integrations/instagram/callback',
    INSTAGRAM_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
    INSTAGRAM_GRAPH_VERSION: 'v26.0',
    INSTAGRAM_WEBHOOK_VERIFY_TOKEN: 'verification-token-for-native-instagram',
    INSTAGRAM_CAPABILITIES_JSON: JSON.stringify({
      privateReplyWindowHours: 168, messagingWindowHours: 24, sendsPerWindow: 100,
      budgetWindowSeconds: 3600, recipientHourlyLimit: 10, reconciliation: 'none',
    }),
  };
  expect(() => loadConfig(native)).toThrow('CONSOLE_ORIGIN');
  expect(() => loadConfig({ ...native, CONSOLE_ORIGIN: 'https://different.example' })).toThrow('match');
  const config = loadConfig({ ...native, CONSOLE_ORIGIN: 'https://operator.example', ROLE: 'relay', TEMPORAL_ADDRESS: 'localhost:7233' });
  expect(config.nativeInstagram?.graphVersion).toBe('v26.0');
  expect(config.crm).toBeUndefined();
  expect(config.alertSink).toBeUndefined();
});

it('validates secret-free API delivery expectations without inventing integrations',()=>{
 const cfg=loadConfig({...database,EXPECTED_DELIVERIES:'crm, alerts, metadata'});
 expect(cfg.expectedDeliveries).toEqual(['crm','alerts','metadata']);
 expect(cfg.crm).toBeUndefined();expect(cfg.telegramBotToken).toBeUndefined();expect(cfg.alertSink).toBeUndefined();
 expect(loadConfig({...database,EXPECTED_DELIVERIES:'  '}).expectedDeliveries).toEqual([]);
 for(const value of ['crm,crm','unknown','crm,','alerts,,metadata','CRM'])
   expect(()=>loadConfig({...database,EXPECTED_DELIVERIES:value})).toThrow('EXPECTED_DELIVERIES');
});
