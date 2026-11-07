export type RunOutcome = 'completed' | 'expired' | 'cancelled' | 'failed';
export type RunStatus = 'starting' | 'running' | 'waiting_input' | 'blocked_unknown' | RunOutcome;

export type SendKind = 'comment_reply' | 'private_reply' | 'dm';

/**
 * The adapter contract for one connected account. Values are configuration, not facts about Meta:
 * the real limits must be confirmed for the chosen login route and API version before production.
 */
export interface Capabilities {
  /** How long after a comment a private reply is still allowed. */
  privateReplyWindowHours: number;
  /** How long after the participant's last DM a regular DM is allowed. */
  messagingWindowHours: number;
  /** Shared account budget: sends per fixed window, reserved before each call. */
  sendsPerWindow: number;
  budgetWindowSeconds: number;
  /** Automated messages to one participant per rolling hour, across all automations. */
  recipientHourlyLimit: number;
  /** Whether the adapter can authoritatively look up a send by our client reference. */
  reconciliation: 'lookup_by_client_ref' | 'none';
}

export const DEFAULT_CAPABILITIES: Capabilities = {
  privateReplyWindowHours: 7 * 24,
  messagingWindowHours: 24,
  sendsPerWindow: 200,
  budgetWindowSeconds: 3600,
  recipientHourlyLimit: 10,
  reconciliation: 'none',
};

export function resolveCapabilities(raw: unknown): Capabilities {
  return { ...DEFAULT_CAPABILITIES, ...((raw as Partial<Capabilities>) ?? {}) };
}

export type SendStepResult =
  | { status: 'accepted'; intentId: string; providerMessageId: string | null }
  | { status: 'deferred'; intentId: string; retryAfterMs: number; reason: string }
  | { status: 'unknown'; intentId: string; reason: string }
  | { status: 'rejected' | 'blocked' | 'cancelled'; intentId: string; reason: string };

export type WaitEvaluation =
  | { kind: 'valid'; leadId: string }
  | { kind: 'clarify'; actionNo: number }
  | { kind: 'waiting'; msUntilDeadline: number }
  | { kind: 'expired' }
  | { kind: 'cancelled'; reason: string };
