import { z } from 'zod';

/**
 * Normalised events produced by the existing Instagram integration (which already verifies webhook
 * signatures and fetches what it needs). We accept only what the automation needs: minimal payload.
 */
const Id = z.string().trim().min(1).max(200);

export const CommentCreatedSchema = z.object({
  type: z.literal('comment.created'),
  accountId: Id,
  commentId: Id,
  mediaId: Id,
  from: z.object({ id: Id, username: z.string().max(100).optional() }),
  text: z.string().max(5000),
  occurredAt: z.string().datetime({ offset: true }),
});

export const MessageReceivedSchema = z.object({
  type: z.literal('message.received'),
  accountId: Id,
  messageId: Id,
  from: z.object({ id: Id }),
  text: z.string().max(5000),
  occurredAt: z.string().datetime({ offset: true }),
  isEcho: z.boolean().optional(),
});

export const NormalizedEventSchema = z.discriminatedUnion('type', [CommentCreatedSchema, MessageReceivedSchema]);
export type NormalizedEvent = z.infer<typeof NormalizedEventSchema>;
