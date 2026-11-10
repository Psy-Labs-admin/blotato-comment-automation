import { isUtf8 } from 'node:buffer';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import type { Clock } from '../domain/clock';
import { isStopCommand } from '../domain/matching';
import type { Metrics } from '../observability/metrics';
import { ingestEvent } from '../ingest/ingest';
import { providerId, type NormalizedEvent } from '../ingest/events';
import { storableText as Text } from '../storage/text';

const envelope = z.object({
  object: z.literal('instagram'), entry: z.array(z.unknown()).max(1000),
});
const entrySchema = z.object({
  id: providerId, time: z.number().finite().nonnegative().max(8_640_000_000_000_000),
  changes: z.array(z.unknown()).catch([]).optional(), messaging: z.array(z.unknown()).catch([]).optional(),
});
const changeSchema = z.object({ field: z.string(), value: z.unknown() });
const comment = z.object({
  id: providerId, text: Text.max(5000), from: z.object({ id: providerId, username: Text.max(100).optional() }),
  media: z.object({ id: providerId }), timestamp: z.union([z.string(), z.number()]).optional(), verb: z.string().optional(),
});
const message = z.object({
  sender: z.object({ id: providerId }), recipient: z.object({ id: providerId }), timestamp: z.number().finite().nonnegative().max(8_640_000_000_000_000),
  message: z.object({ mid: providerId, text: Text.max(5000).optional(), is_echo: z.boolean().optional(), is_deleted: z.boolean().optional() }),
});

export interface InstagramWebhookDeps {
  db: Pool;
  clock: Clock;
  appSecret: string;
  verifyToken: string;
  onOutbox?: () => void;
  metrics?: Metrics;
}

function matchesSecret(actual: unknown, expected: string): boolean {
  if (typeof actual !== 'string') return false;
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(actual), digest(expected));
}

export function validInstagramSignature(raw: Buffer, signature: unknown, appSecret: string): boolean {
  if (typeof signature !== 'string' || !/^sha256=[0-9a-f]{64}$/.test(signature)) return false;
  const expected = createHmac('sha256', appSecret).update(raw).digest();
  return timingSafeEqual(expected, Buffer.from(signature.slice(7), 'hex'));
}

function occurredAt(raw: string | number, fallback: number): string {
  let milliseconds: number;
  if (typeof raw === 'string') milliseconds = Date.parse(raw);
  else milliseconds = raw < 1_000_000_000_000 ? raw * 1000 : raw;
  if (!Number.isFinite(milliseconds) || milliseconds < 0 || milliseconds > 8_640_000_000_000_000) {
    milliseconds = fallback < 1_000_000_000_000 ? fallback * 1000 : fallback;
  }
  return new Date(milliseconds).toISOString();
}

/** Shared verification route for the application and the isolated webhook listener. */
export function registerInstagramWebhookVerification(app: FastifyInstance, verifyToken: string): void {
  app.get('/integrations/instagram/webhook', { exposeHeadRoute: false }, async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const query = req.query as Record<string, unknown>;
    if (query['hub.mode'] !== 'subscribe' || !matchesSecret(query['hub.verify_token'], verifyToken) ||
      typeof query['hub.challenge'] !== 'string' || query['hub.challenge'].length === 0 || query['hub.challenge'].length > 1024) {
      return reply.code(403).send({ error: 'Invalid webhook verification' });
    }
    return reply.type('text/plain').send(query['hub.challenge']);
  });
}

/** Native Meta callbacks are authenticated before their account IDs are mapped to stored accounts. */
export function registerInstagramWebhook(app: FastifyInstance, deps: InstagramWebhookDeps): void {
  app.register(async (hooks) => {
    hooks.addContentTypeParser('application/json', { parseAs: 'buffer', bodyLimit: 1024 * 1024 }, (_req, bytes, done) => done(null, bytes));
    registerInstagramWebhookVerification(hooks, deps.verifyToken);
    hooks.post('/integrations/instagram/webhook', async (req, reply) => {
      const count = (result: string) => deps.metrics?.nativeWebhookDeliveries.inc({ result });
      try {
        if (!Buffer.isBuffer(req.body) || !validInstagramSignature(req.body, req.headers['x-hub-signature-256'], deps.appSecret)) {
          count('invalid');
          return reply.code(401).send({ error: 'Invalid Instagram signature' });
        }
        let raw: unknown;
        try {
          if (!isUtf8(req.body)) throw new Error('Invalid UTF-8');
          raw = JSON.parse(req.body.toString('utf8'));
        } catch {
          count('invalid');
          return reply.code(400).send({ error: 'Invalid JSON' });
        }
        const parsed = envelope.safeParse(raw);
        if (!parsed.success) {
          count('invalid');
          return reply.code(400).send({ error: 'Invalid Instagram webhook' });
        }
        let accepted = 0;
        for (const rawEntry of parsed.data.entry) {
          const parsedEntry = entrySchema.safeParse(rawEntry);
          if (!parsedEntry.success) continue;
          const entry = parsedEntry.data;
          const account = await deps.db.query(
            `SELECT c.id, c.status, c.verified_at, k.expires_at FROM social_connections c JOIN instagram_credentials k ON k.connection_id = c.id
             WHERE c.platform = 'instagram' AND c.external_account_id = $1 AND c.integration_kind = 'native' AND c.status <> 'disconnected'`,
            [entry.id],
          );
          if (!account.rowCount) continue;
          const binding = account.rows[0];
          const ordinary = binding.status === 'active' && binding.verified_at && binding.expires_at > deps.clock.now();
          const events: NormalizedEvent[] = [];
          for (const rawChange of entry.changes ?? []) {
            const change = changeSchema.safeParse(rawChange);
            if (!ordinary || !change.success || change.data.field !== 'comments') continue;
            const value = comment.safeParse(change.data.value);
            if (!value.success || (value.data.verb && !['add', 'created'].includes(value.data.verb))) continue;
            events.push({
              type: 'comment.created', accountId: entry.id, commentId: value.data.id, mediaId: value.data.media.id,
              from: value.data.from, text: value.data.text, occurredAt: occurredAt(value.data.timestamp ?? entry.time, entry.time),
            });
          }
          for (const item of entry.messaging ?? []) {
            const value = message.safeParse(item);
            if (!value.success || value.data.message.is_deleted) continue;
            const event = value.data;
            const echo = event.message.is_echo === true || event.sender.id === entry.id;
            if (echo ? event.sender.id !== entry.id : event.recipient.id !== entry.id) continue;
            // A user's opt-out remains effective while their account token is being reconnected.
            if (!ordinary && (echo || !isStopCommand(event.message.text ?? ''))) continue;
            events.push({
              type: 'message.received', accountId: entry.id, messageId: event.message.mid,
              from: { id: echo ? event.recipient.id : event.sender.id }, text: event.message.text ?? '',
              occurredAt: occurredAt(event.timestamp, entry.time), isEcho: echo,
            });
          }
          for (const event of events) {
            const result = await ingestEvent({ db: deps.db, clock: deps.clock, source:'native' }, event);
            const outcome = result.status === 'accepted' && result.duplicate ? 'duplicate' : result.status;
            deps.metrics?.nativeWebhookEvents.inc({ type: event.type, result: outcome });
            // Invalid input and unknown accounts are permanent. A storage failure throws and fails the delivery.
            if (result.status === 'rejected') continue;
            accepted++;
          }
        }
        deps.onOutbox?.();
        count(accepted ? 'accepted' : 'ignored');
        return { received: true, accepted };
      } catch (error) {
        count('storage_error');
        throw error;
      }
    });
  });
}
