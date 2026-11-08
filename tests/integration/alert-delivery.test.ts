import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb } from '../helpers/db';
import { seedTenant } from '../helpers/fixtures';
import { raiseIncident, resolveIncident } from '../../src/alerts/incidents';
import { withTx } from '../../src/storage/db';
import { OutboxRelay, type OutboxRow } from '../../src/relay/relay';
import { alertDeliveryHandler } from '../../src/alerts/delivery';
import { TelegramNotifier, telegramChannelKey } from '../../src/adapters/alerts';
import { startServer, sendJson } from '../fixtures/providers/http';
import { NotificationError } from '../../src/alerts/errors';

describe('durable operator notifications', () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  beforeAll(async () => {
    t = await createTestDb();
  });
  afterAll(async () => t?.drop());
  async function incident() {
    const tenant = await seedTenant(t.db);
    await withTx(t.db, (c) => raiseIncident(c, { tenantId: tenant.tenantId, errorClass: 'crm_delivery_failing' }));
    return tenant;
  }
  const relay = (handler: ReturnType<typeof alertDeliveryHandler>) =>
    new OutboxRelay({
      db: t.db,
      kinds: ['alert.notify'],
      handlers: { 'alert.notify': handler },
      backoff: () => 0,
    });
  const due = () =>
    t.db.query("UPDATE outbox SET next_attempt_at=now() WHERE kind='alert.notify' AND status='pending'");
  it('serializes two relays, preserves opening before recovery and retains accepted receipts', async () => {
    const tenant = await incident();
    const texts: string[] = [];
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((r) => (enter = r));
    const blocked = new Promise<void>((r) => (release = r));
    const handler = alertDeliveryHandler({
      db: t.db,
      notifier: {
        notify: async (text) => {
          texts.push(text);
          if (texts.length === 1) {
            enter();
            await blocked;
          }
          return { providerMessageId: '5' };
        },
      },
    });
    const first = relay(handler).drainOnce();
    await entered;
    await withTx(t.db, (c) =>
      resolveIncident(c, { tenantId: tenant.tenantId, errorClass: 'crm_delivery_failing' }),
    );
    await relay(handler).drainOnce();
    expect(texts).toHaveLength(1);
    release();
    await first;
    await due();
    await relay(handler).drainOnce();
    expect(texts.map((x) => x.split('\n')[0])).toEqual([
      '[INCIDENT] CRM sync failing',
      '[RESOLVED] CRM sync failing',
    ]);
    const receipt = (
      await t.db.query('SELECT * FROM alert_deliveries WHERE tenant_id=$1 ORDER BY outbox_id', [tenant.tenantId])
    ).rows;
    expect(receipt.map((x) => x.status)).toEqual(['accepted', 'accepted']);
    await t.db.query("UPDATE outbox SET status='pending',next_attempt_at=now() WHERE id=$1", [
      receipt[0].outbox_id,
    ]);
    await relay(handler).drainOnce();
    expect(texts).toHaveLength(2);
  });
  it('coalesces incidents that already recovered before any opening was delivered', async () => {
    const tenant = await incident();
    await withTx(t.db, (c) =>
      resolveIncident(c, { tenantId: tenant.tenantId, errorClass: 'crm_delivery_failing' }),
    );
    let sends = 0;
    const handler = alertDeliveryHandler({
      db: t.db,
      notifier: {
        notify: async () => {
          sends++;
        },
      },
    });
    await relay(handler).drainOnce();
    await due();
    await relay(handler).drainOnce();
    expect(sends).toBe(0);
    expect(
      (await t.db.query('SELECT status FROM alert_deliveries WHERE tenant_id=$1', [tenant.tenantId])).rows.map(
        (x) => x.status,
      ),
    ).toEqual(['skipped', 'skipped']);
  });
  it('shares flood waits across incidents and terminates permanent rejections safely', async () => {
    const a = await incident();
    const b = await incident();
    let calls = 0;
    const handler = alertDeliveryHandler({
      db: t.db,
      notifier: {
        channelKey: 'a'.repeat(64),
        notify: async () => {
          calls++;
          throw new NotificationError('telegram_rate_limited', { retryAfterMs: 120000 });
        },
      },
    });
    await relay(handler).drainOnce();
    await due();
    await relay(handler).drainOnce();
    expect(calls).toBe(1);
    const pending = (
      await t.db.query("SELECT attempts,last_error FROM outbox WHERE tenant_id=ANY($1) AND kind='alert.notify'", [
        [a.tenantId, b.tenantId],
      ])
    ).rows;
    expect(pending.filter((x) => x.attempts === 1)).toHaveLength(1);
    await t.db.query("UPDATE outbox SET status='dead' WHERE tenant_id=ANY($1)", [[a.tenantId, b.tenantId]]);
    const c = await incident();
    await relay(
      alertDeliveryHandler({
        db: t.db,
        notifier: {
          channelKey: 'b'.repeat(64),
          notify: async () => {
            throw new NotificationError('telegram_chat_forbidden', { permanent: true });
          },
        },
      }),
    ).drainOnce();
    expect(
      (
        await t.db.query(
          "SELECT status,attempts,last_error FROM outbox WHERE tenant_id=$1 AND kind='alert.notify'",
          [c.tenantId],
        )
      ).rows[0],
    ).toMatchObject({ status: 'dead', attempts: 1, last_error: 'telegram_chat_forbidden' });
  });
  it('bounds unknown delivery retries and stores only a fixed safe error', async () => {
    const tenant = await incident();
    let calls = 0;
    const handler = alertDeliveryHandler({
      db: t.db,
      notifier: {
        channelKey: 'c'.repeat(64),
        notify: async () => {
          calls++;
          throw new Error('https://api.telegram.org/botSECRET private@example.com');
        },
      },
    });
    const bounded = new OutboxRelay({
      db: t.db,
      kinds: ['alert.notify'],
      handlers: { 'alert.notify': handler },
      backoff: () => 0,
      maxAttempts: 2,
    });
    await bounded.drainOnce();
    await due();
    await bounded.drainOnce();
    await due();
    await bounded.drainOnce();
    expect(calls).toBe(2);
    expect(
      (
        await t.db.query(
          "SELECT status,attempts,last_error FROM outbox WHERE tenant_id=$1 AND kind='alert.notify'",
          [tenant.tenantId],
        )
      ).rows[0],
    ).toEqual({ status: 'dead', attempts: 2, last_error: 'alert_delivery_unknown' });
    expect(
      (
        await t.db.query('SELECT status,attempts,last_error_code FROM alert_deliveries WHERE tenant_id=$1', [
          tenant.tenantId,
        ])
      ).rows[0],
    ).toEqual({ status: 'unknown', attempts: 2, last_error_code: 'alert_delivery_unknown' });
  });
  it('keeps accepted receipts immutable while new destinations receive an opening, not an update or orphan recovery', async () => {
    const tenant = await incident();
    const texts: string[] = [];
    const make = (key: string) =>
      alertDeliveryHandler({
        db: t.db,
        notifier: {
          channel: 'telegram',
          channelKey: key.repeat(64),
          notify: async (text) => {
            texts.push(text);
            return { providerMessageId: '9' };
          },
        },
      });
    await relay(make('d')).drainOnce();
    const first = (await t.db.query('SELECT * FROM alert_deliveries WHERE tenant_id=$1', [tenant.tenantId]))
      .rows[0];
    await t.db.query("UPDATE outbox SET status='pending',next_attempt_at=now() WHERE id=$1", [first.outbox_id]);
    await relay(make('e')).drainOnce();
    expect(texts).toHaveLength(1);
    expect(
      (await t.db.query('SELECT channel_key FROM alert_deliveries WHERE outbox_id=$1', [first.outbox_id])).rows[0]
        .channel_key,
    ).toBe('d'.repeat(64));
    await t.db.query("UPDATE incidents SET last_notified_at=now()-interval '16 minutes' WHERE tenant_id=$1", [
      tenant.tenantId,
    ]);
    await withTx(t.db, (c) => raiseIncident(c, { tenantId: tenant.tenantId, errorClass: 'crm_delivery_failing' }));
    await relay(make('e')).drainOnce();
    expect(texts[1]).toContain('[INCIDENT] CRM sync failing');
    await withTx(t.db, (c) =>
      resolveIncident(c, { tenantId: tenant.tenantId, errorClass: 'crm_delivery_failing' }),
    );
    await relay(make('f')).drainOnce();
    expect(texts).toHaveLength(2);
    expect(
      (
        await t.db.query(
          'SELECT status,channel_key FROM alert_deliveries WHERE tenant_id=$1 ORDER BY outbox_id DESC LIMIT 1',
          [tenant.tenantId],
        )
      ).rows[0],
    ).toMatchObject({ status: 'skipped', channel_key: 'f'.repeat(64) });
  });
  it('updates the recorded destination on retry of an unconfirmed delivery', async () => {
    const tenant = await incident();
    await relay(
      alertDeliveryHandler({
        db: t.db,
        notifier: {
          channel: 'webhook',
          channelKey: '1'.repeat(64),
          notify: async () => {
            throw new NotificationError('alert_delivery_unknown', { uncertain: true });
          },
        },
      }),
    ).drainOnce();
    await due();
    await relay(
      alertDeliveryHandler({
        db: t.db,
        notifier: {
          channel: 'telegram',
          channelKey: '2'.repeat(64),
          notify: async () => ({ providerMessageId: '10' }),
        },
      }),
    ).drainOnce();
    expect(
      (
        await t.db.query(
          'SELECT status,channel,channel_key,attempts,provider_message_id FROM alert_deliveries WHERE tenant_id=$1',
          [tenant.tenantId],
        )
      ).rows[0],
    ).toEqual({
      status: 'accepted',
      channel: 'telegram',
      channel_key: '2'.repeat(64),
      attempts: 2,
      provider_message_id: '10',
    });
  });
  it('retains accepted-opening context and flood waits when a bot token rotates', async () => {
    const tenant = await incident();
    const texts: string[] = [];
    const server = await startServer((_req, res, body) => {
      texts.push(body.text);
      sendJson(res, 200, { ok: true, result: { message_id: texts.length, chat: { id: -100 } } });
    });
    try {
      await relay(
        alertDeliveryHandler({ db: t.db, notifier: new TelegramNotifier('123:old_secret', '-100', server.url) }),
      ).drainOnce();
      await withTx(t.db, (c) =>
        resolveIncident(c, { tenantId: tenant.tenantId, errorClass: 'crm_delivery_failing' }),
      );
      await relay(
        alertDeliveryHandler({ db: t.db, notifier: new TelegramNotifier('123:new_secret', '-100', server.url) }),
      ).drainOnce();
      expect(texts.map((text) => text.split('\n')[0])).toEqual([
        '[INCIDENT] CRM sync failing',
        '[RESOLVED] CRM sync failing',
      ]);
    } finally {
      await server.close();
    }
    const pending = await incident();
    let calls = 0;
    const make = (secret: string) =>
      alertDeliveryHandler({
        db: t.db,
        notifier: {
          channel: 'telegram',
          channelKey: telegramChannelKey('456:' + secret, '-200'),
          notify: async () => {
            calls++;
            throw new NotificationError('telegram_rate_limited', { retryAfterMs: 120000 });
          },
        },
      });
    await relay(make('old_secret')).drainOnce();
    await due();
    await relay(make('new_secret')).drainOnce();
    expect(calls).toBe(1);
    await t.db.query("UPDATE outbox SET status='dead' WHERE tenant_id=$1 AND kind='alert.notify'", [
      pending.tenantId,
    ]);
  });
  it('rejects cross-tenant incident references before sending', async () => {
    const a = await incident();
    const b = await seedTenant(t.db);
    const stored = (
      await t.db.query("SELECT * FROM outbox WHERE tenant_id=$1 AND kind='alert.notify'", [a.tenantId])
    ).rows[0];
    const row: OutboxRow = {
      id: stored.id,
      tenantId: b.tenantId,
      kind: 'alert.notify',
      payload: stored.payload,
      attempts: 0,
      idempotencyKey: stored.idempotency_key,
    };
    let sent = false;
    await expect(
      alertDeliveryHandler({
        db: t.db,
        notifier: {
          notify: async () => {
            sent = true;
          },
        },
      })(row),
    ).rejects.toMatchObject({ code: 'alert_scope_invalid' });
    expect(sent).toBe(false);
    await t.db.query("UPDATE outbox SET status='dead' WHERE id=$1", [stored.id]);
  });
});
