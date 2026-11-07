/**
 * All business time (received_at, prompt start, deadlines) comes from one injected clock.
 * Production uses the system clock of the node that holds the conversation lock; with
 * several nodes, NTP skew is bounded and the expiry loop re-checks `now >= deadline`
 * before closing a wait, so a slightly early timer cannot drop an in-time answer.
 */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };
