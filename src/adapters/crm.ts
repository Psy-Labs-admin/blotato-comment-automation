export interface LeadCapturedEvent {
  eventId: string;
  leadId: string;
  tenantId: string;
  email: string;
  source: { runId: string; commentId: string | null; mediaId: string | null };
}

export interface CrmClient {
  /** Must be idempotent per key on the CRM side (upsert), so redelivery never duplicates a contact. */
  upsertLead(e: LeadCapturedEvent, idempotencyKey: string): Promise<void>;
}

export class HttpCrmClient implements CrmClient {
  constructor(
    private readonly baseUrl: string,
    private readonly opts: { timeoutMs: number } = { timeoutMs: 5_000 },
  ) {}

  async upsertLead(e: LeadCapturedEvent, idempotencyKey: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/leads`, {
      method: 'POST',
      redirect: 'error',
      headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
      body: JSON.stringify(e),
      signal: AbortSignal.timeout(this.opts.timeoutMs),
    });
    if (!res.ok) throw new Error(`CRM upsert failed: HTTP ${res.status}`);
  }
}
