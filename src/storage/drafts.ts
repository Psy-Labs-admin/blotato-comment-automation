import type { PoolClient } from 'pg';
import { z } from 'zod';
import { parseDefinition, type AutomationDefinition } from '../domain/definition';
import { parseCapabilities, missingCapabilities, type IntegrationMode } from '../domain/types';

const OptionalText = z.string().max(1000);
export const DraftContentSchema = z.object({
  keyword: z.string().max(60).optional(),
  publicReply: OptionalText.optional(),
  emailPrompt: OptionalText.optional(),
  linkText: OptionalText.optional(),
  linkUrl: z.string().max(2048).optional(),
  timeoutHours: z.number().int().min(1).max(720).optional(),
  clarificationText: OptionalText.optional(),
  maxClarifications: z.number().int().min(0).max(3).optional(),
  postIds: z.array(z.string().trim().min(1).max(200)).max(1000).optional(),
}).strict();
export type DraftContent = z.infer<typeof DraftContentSchema>;

export class OperatorError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) { super(message); }
}

export function connectionIssue(account: any, dispatchConfigured: boolean, mode: IntegrationMode = 'unconfigured', now = new Date()): string | null {
  if (!account.verified_at || account.status !== 'active') return 'reconnect_required';
  if (mode === 'native' && (account.integration_kind !== 'native' || !account.native_expires_at || new Date(account.native_expires_at) <= now)) return 'reconnect_required';
  if (mode === 'gateway' && (account.integration_kind === 'native' || account.native_expires_at)) return 'integration_mismatch';
  if (account.sends_paused) return 'paused';
  const caps = parseCapabilities(account.capabilities);
  const missing = [...missingCapabilities(caps, 'private_reply'), ...missingCapabilities(caps, 'dm')];
  if (missing.length || !caps.privateReplyWindowHours || !caps.messagingWindowHours || !caps.sendsPerWindow || !caps.recipientHourlyLimit) return 'permissions_required';
  return dispatchConfigured && mode !== 'unconfigured' ? null : 'delivery_unconfigured';
}

/** Caller retains this lock until publishing/enabling is committed. */
export async function assertPublishableConnection(c: PoolClient, tenantId: string, connectionId: string, dispatchConfigured: boolean, mode: IntegrationMode = 'unconfigured'): Promise<void> {
  const account = (await c.query(
    `SELECT sc.status, sc.sends_paused, sc.capabilities, sc.verified_at, sc.integration_kind, i.expires_at AS native_expires_at
      FROM social_connections sc LEFT JOIN instagram_credentials i ON i.connection_id = sc.id
      WHERE sc.id = $1 AND sc.tenant_id = $2 FOR NO KEY UPDATE OF sc`,
    [connectionId, tenantId],
  )).rows[0];
  if (!account) throw new OperatorError(404, 'account_not_found', 'The connected account was not found.');
  const issue = connectionIssue(account, dispatchConfigured, mode);
  const messages: Record<string, string> = {
    reconnect_required: 'Connect or reconnect this Instagram account before publishing.',
    paused: 'Resume this account before publishing.',
    permissions_required: 'The account integration must confirm messaging permissions and limits.',
    delivery_unconfigured: 'Configure message delivery before publishing.',
    integration_mismatch: 'Reconnect this account through the configured Instagram integration.',
  };
  if (issue) throw new OperatorError(409, issue, messages[issue]);
}

export function draftDefinition(content: DraftContent): AutomationDefinition {
  const url = z.string().url().refine((value) => {
    const parsed = new URL(value);
    return ['https:', 'http:'].includes(parsed.protocol) && !parsed.username && !parsed.password;
  }).safeParse(content.linkUrl);
  if (!url.success) throw new OperatorError(400, 'invalid_link', 'Enter the complete link to send in the conversation.');
  const maxClarifications = content.maxClarifications ?? 1;
  return parseDefinition({
    schemaVersion: 1,
    trigger: {
      type: 'comment.created', platform: 'instagram', keyword: content.keyword, match: 'whole_word_case_insensitive',
      posts: content.postIds?.length ? { mediaIds: content.postIds } : 'all_supported',
    },
    steps: [
      { id: 'public_reply', type: 'reply_comment', text: content.publicReply },
      { id: 'ask_email', type: 'send_private_reply', text: content.emailPrompt },
      {
        id: 'email', type: 'await_input', validator: 'email', promptStep: 'ask_email', timeout: `${content.timeoutHours ?? 72}h`,
        maxClarifications, clarificationText: maxClarifications ? content.clarificationText : content.emailPrompt,
      },
      { id: 'send_link', type: 'send_message', text: [content.linkText?.trim(), url.data].filter(Boolean).join('\n') },
    ],
  });
}

export function draftDto(row: any) {
  return {
    id: row.id, name: row.name, content: row.content, connectionId: row.connection_id, automationId: row.automation_id,
    revision: row.revision, publishedRevision: row.published_revision, publishedVersionId: row.published_version_id,
    updatedAt: row.updated_at,
    status: row.published_revision !== row.revision ? 'draft' : row.automation_status === 'disabled' ? 'paused' : 'published',
  };
}
