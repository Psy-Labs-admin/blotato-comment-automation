import { NotificationError } from '../alerts/errors';
import type { Tracing } from '../observability/tracing';
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { withTx } from '../storage/db';
import type { OutboxKind } from '../storage/outbox';

export interface OutboxRow {
  id: string;
  tenantId: string | null;
  kind: OutboxKind;
  idempotencyKey: string;
  payload: any;
  attempts: number;
  claimToken?: string;
}

/** Return `{ retryInMs }` for "not yet" (e.g. signal before workflow start): rescheduled, no attempt burned. Throw for failure. */
export type OutboxHandler = (row: OutboxRow) => Promise<void | { retryInMs: number; reason: string }>;

export interface RelayOptions {
  tracing?: Tracing;
  db: Pool;
  kinds: OutboxKind[];
  handlers: Partial<Record<OutboxKind, OutboxHandler>>;
  batchSize?: number;
  leaseMs?: number;
  pollMs?: number;
  maxAttempts?: number;
  backoff?: (attempt: number) => number;
  onDead?: (c: PoolClient, row: OutboxRow, error: string) => Promise<void>;
  onError?: (err: unknown) => void;
  onCycle?: (error?: unknown) => void;
}

export function jitteredBackoff(attempt: number, baseMs = 500, maxMs = 60_000): number {
  const exp = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.round(exp * (0.5 + Math.random() * 0.5));
}

/**
 * Delivers outbox rows at least once. Rows are claimed in a short transaction with
 * FOR UPDATE SKIP LOCKED plus a lease, and the external call happens after commit, so no transaction or row lock
 * is held across the network. Alert delivery may hold a destination advisory lock. A lease protects local work only: handlers must be idempotent
 * (fixed workflow ids, wake-up signals, CRM idempotency keys).
 *
 * Several relays (one per kind group, e.g. Temporal commands vs CRM) keep a slow CRM from
 * delaying workflow starts.
 */
export class OutboxRelay {
  private running = false;
  private loop?: Promise<void>;
  private wake?: () => void;

  constructor(private readonly o: RelayOptions) {}

  async drainOnce(): Promise<number> {
    const { db, kinds } = this.o;
    const claimToken = randomUUID();
    const rows = await withTx(db, async (c) => {
      const r = await c.query(
        `SELECT o.id, o.tenant_id, o.kind, o.idempotency_key, o.payload, o.attempts FROM outbox o
          WHERE o.status = 'pending' AND o.kind = ANY($1) AND o.next_attempt_at <= now()
            AND (o.locked_until IS NULL OR o.locked_until < now())
            AND (o.kind <> 'alert.notify' OR NOT EXISTS (
              SELECT 1 FROM outbox earlier
               WHERE earlier.kind='alert.notify' AND earlier.status='pending'
                 AND earlier.tenant_id=o.tenant_id
                 AND earlier.payload->>'incidentId'=o.payload->>'incidentId' AND earlier.id<o.id
            ))
          ORDER BY o.id LIMIT $2 FOR UPDATE OF o SKIP LOCKED`,
        [kinds, this.o.batchSize ?? 20],
      );
      if (r.rowCount) {
        await c.query(`UPDATE outbox SET locked_until = now() + make_interval(secs => $2), claim_token = $3 WHERE id = ANY($1)`, [
          r.rows.map((x) => x.id),
          (this.o.leaseMs ?? 30_000) / 1000,
          claimToken,
        ]);
      }
      return r.rows.map(
        (x): OutboxRow => ({ id: x.id, tenantId: x.tenant_id, kind: x.kind, idempotencyKey: x.idempotency_key, payload: x.payload, attempts: x.attempts, claimToken }),
      );
    });
    await Promise.all(rows.map((row) => this.process(row, claimToken)));
    return rows.length;
  }

  private async process(row: OutboxRow, claimToken: string): Promise<void> {
    const { db } = this.o;
    const handler = this.o.handlers[row.kind];
    try {
      if (!handler) throw new Error(`no handler for ${row.kind}`);
      const res = await (this.o.tracing ? this.o.tracing.withSpan('relay.deliver', () => handler(row)) : handler(row));
      if (res && 'retryInMs' in res) {
        await db.query(
          `UPDATE outbox SET next_attempt_at = now() + make_interval(secs => $2), locked_until = NULL, claim_token = NULL, last_error = $3 WHERE id = $1 AND status = 'pending' AND claim_token = $4`,
          [row.id, res.retryInMs / 1000, res.reason, claimToken],
        );
        return;
      }
      await db.query(
        `UPDATE outbox SET status = 'done', done_at = now(), attempts = attempts + 1, locked_until = NULL, claim_token = NULL WHERE id = $1 AND status = 'pending' AND claim_token = $2`,
        [row.id, claimToken],
      );
    } catch (err) {
      const attempts = row.attempts + 1;
      const error = err instanceof NotificationError ? err.code : String(err);
      if ((err instanceof NotificationError && err.options.permanent) || attempts >= (this.o.maxAttempts ?? 25)) {
        await withTx(db, async (c) => {
          const dead = await c.query(
            `UPDATE outbox SET status = 'dead', done_at = now(), attempts = $2, last_error = $3, locked_until = NULL, claim_token = NULL WHERE id = $1 AND status = 'pending' AND claim_token = $4`,
            [row.id, attempts, error, claimToken],
          );
          if (dead.rowCount) await this.o.onDead?.(c, { ...row, attempts }, error);
        });
      } else {
        const delay = Math.max((this.o.backoff ?? jitteredBackoff)(attempts), err instanceof NotificationError ? err.options.retryAfterMs ?? 0 : 0);
        await db.query(
          `UPDATE outbox SET attempts = $2, last_error = $3, locked_until = NULL, claim_token = NULL,
             next_attempt_at = now() + make_interval(secs => $4) WHERE id = $1 AND status = 'pending' AND claim_token = $5`,
          [row.id, attempts, error, delay / 1000, claimToken],
        );
      }
    }
  }

  /** Wake the loop now (called after a transaction wrote outbox rows). */
  poke(): void {
    this.wake?.();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = (async () => {
      while (this.running) {
        let n = 0;
        try {
          n = await this.drainOnce();
          this.observeCycle();
        } catch (err) {
          this.observeCycle(err);
          this.o.onError?.(err);
        }
        if (n === 0 && this.running) {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, this.o.pollMs ?? 250);
            this.wake = () => {
              clearTimeout(timer);
              resolve();
            };
          });
          this.wake = undefined;
        }
      }
    })();
  }

  private observeCycle(error?: unknown): void {
    try { this.o.onCycle?.(error); } catch { /* Monitoring must not interrupt delivery. */ }
  }

  async stop(): Promise<void> {
    this.running = false;
    this.wake?.();
    await this.loop;
  }
}
