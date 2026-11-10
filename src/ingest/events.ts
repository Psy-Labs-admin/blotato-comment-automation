import { z } from 'zod';
import { storableText as Text } from '../storage/text';

/**
 * Normalised events produced by the existing Instagram integration (which already verifies webhook
 * signatures and fetches what it needs). We accept only what the automation needs: minimal payload.
 */
// Provider IDs are opaque. Trimming a signed sender ID could apply STOP to a different person.
export const providerId = Text.min(1).max(200).refine(
  (value) => value === value.trim() && !/\p{Cc}/u.test(value), 'Invalid identity',
);

// Postgres rejects year zero and numeric UTC offsets of 16 hours or more.
export const eventTimestamp = z.string().datetime({ offset: true }).refine(
  (value) => !value.startsWith('0000-') && !/[+-](?:1[6-9]|2[0-3]):?\d{2}$/.test(value),
  'Timestamp cannot be stored',
);

export const CommentCreatedSchema = z.object({
  type: z.literal('comment.created'),
  accountId: providerId,
  commentId: providerId,
  mediaId: providerId,
  from: z.object({ id: providerId, username: Text.max(100).optional() }),
  text: Text.max(5000),
  occurredAt: eventTimestamp,
});

export const MessageReceivedSchema = z.object({
  type: z.literal('message.received'),
  accountId: providerId,
  messageId: providerId,
  from: z.object({ id: providerId }),
  text: Text.max(5000),
  occurredAt: eventTimestamp,
  isEcho: z.boolean().optional(),
});

export const NormalizedEventSchema = z.discriminatedUnion('type', [CommentCreatedSchema, MessageReceivedSchema]);
export type NormalizedEvent = z.infer<typeof NormalizedEventSchema>;
