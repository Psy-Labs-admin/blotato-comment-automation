export type IntegrationMode = 'native' | 'gateway' | 'unconfigured';

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

const NUMERIC_CAPABILITIES = [
  'privateReplyWindowHours',
  'messagingWindowHours',
  'sendsPerWindow',
  'budgetWindowSeconds',
  'recipientHourlyLimit',
] as const;

/**
 * Strict reading of a stored adapter contract: only well-formed values survive. Nothing is filled
 * in from defaults here — a capability that is unknown for an account must forbid the sends that
 * depend on it (see `missingCapabilities`). Confirmed limits are stored when a connection is verified.
 */
export function parseCapabilities(raw: unknown): Partial<Capabilities> {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const out: Partial<Capabilities> = {};
  for (const k of NUMERIC_CAPABILITIES) {
    const v = r[k];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) continue;
    if (k === 'budgetWindowSeconds' && (v === 0 || !Number.isFinite(v * 1000))) continue;
    if ((k === 'sendsPerWindow' || k === 'recipientHourlyLimit') && !Number.isSafeInteger(v)) continue;
    out[k] = v;
  }
  if (r.reconciliation === 'lookup_by_client_ref' || r.reconciliation === 'none') out.reconciliation = r.reconciliation;
  return out;
}

/** Capabilities a send of this kind cannot be evaluated without. */
export function missingCapabilities(caps: Partial<Capabilities>, kind: SendKind): string[] {
  const required: Array<keyof Capabilities> = ['sendsPerWindow', 'budgetWindowSeconds', 'recipientHourlyLimit'];
  if (kind === 'private_reply') required.push('privateReplyWindowHours');
  if (kind === 'dm') required.push('messagingWindowHours');
  return required.filter((k) => caps[k] === undefined);
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
