/**
 * Every routing decision, suppression, block and failure carries one of these codes.
 * They are stable identifiers for the timeline, metrics and support tooling.
 */
export const Reason = {
  // routing
  STARTED: 'started',
  NO_MATCH: 'no_match',
  LOWER_PRIORITY: 'lower_priority',
  CONVERSATION_BUSY: 'conversation_busy',
  COOLDOWN: 'cooldown',
  OPTED_OUT: 'opted_out',
  HUMAN_TAKEOVER: 'human_takeover',
  IGNORED_SELF: 'ignored_self',
  CONNECTION_INACTIVE: 'connection_inactive',
  NO_ACTIVE_RUN: 'no_active_run',
  NO_ACTIVE_WAIT: 'no_active_wait',
  BEFORE_PROMPT: 'before_prompt',
  INPUT_PENDING: 'input_pending',
  STOP_COMMAND: 'stop_command',
  // send policy
  RUN_CANCELLED: 'run_cancelled',
  SENDS_PAUSED: 'sends_paused',
  WINDOW_CLOSED: 'window_closed',
  RATE_LIMITED: 'rate_limited',
  RECIPIENT_LIMIT: 'recipient_limit',
  CAPABILITY_UNKNOWN: 'capability_unknown',
  // send outcomes
  PROVIDER_REJECTED: 'provider_rejected',
  PROVIDER_UNAUTHORIZED: 'provider_unauthorized',
  PROVIDER_THROTTLED: 'provider_throttled',
  PROVIDER_NO_CONFIRMATION: 'provider_no_confirmation',
  ATTEMPT_OUTCOME_LOST: 'attempt_outcome_lost',
  DEFERRAL_BUDGET_EXHAUSTED: 'deferral_budget_exhausted',
  // input
  EMAIL_VALID: 'email_valid',
  EMAIL_INVALID: 'email_invalid',
  EMAIL_AMBIGUOUS: 'email_ambiguous',
  DEADLINE_PASSED: 'deadline_passed',
  // run lifecycle
  ACTIVITY_FAILED: 'activity_failed',
  WORKFLOW_CLOSED: 'workflow_closed',
} as const;

export type ReasonCode = (typeof Reason)[keyof typeof Reason];
