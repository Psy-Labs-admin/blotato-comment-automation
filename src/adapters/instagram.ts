import type { SendKind } from '../domain/types';

export interface SendRequest {
  kind: SendKind;
  accountId: string;
  commentId?: string;
  recipientId?: string;
  text: string;
  /** Our intent id. Sent along so a provider (or the fake) that supports lookups can reconcile. */
  clientRef: string;
}

/**
 * The four outcomes the send ledger needs. The important distinction is between `not_sent`
 * (provably no effect: safe to retry the same intent) and `unknown` (may have been delivered:
 * never retried automatically).
 */
export type SendOutcome =
  | { status: 'accepted'; providerMessageId: string; httpStatus: number }
  | { status: 'rejected'; code: string; httpStatus: number }
  | { status: 'not_sent'; code: string; retryAfterMs: number; httpStatus?: number }
  | { status: 'unknown'; code: string; httpStatus?: number };

export type LookupResult = { found: true; providerMessageId: string } | { found: false };

export interface SocialPlatform {
  send(req: SendRequest): Promise<SendOutcome>;
  /** Authoritative lookup by client reference; only present when the provider contract supports it. */
  lookupByClientRef?(accountId: string, clientRef: string): Promise<LookupResult>;
}

// Graph API error codes. 190/102: token/session invalid -> the account must be reconnected.
// 4/17/32/613: application/user/page rate limits -> request rejected before processing.
// Others (e.g. 10 "outside of allowed window", 551 "person isn't available") concern this message only.
const AUTH_ERROR_CODES = new Set([190, 102]);
const THROTTLE_ERROR_CODES = new Set([4, 17, 32, 613]);

/**
 * HTTP adapter for the existing Instagram integration. No retries in here: one call, one attempt,
 * so every attempt is visible in the ledger and governed by the same policy.
 */
export class HttpInstagramAdapter implements SocialPlatform {
  constructor(
    private readonly baseUrl: string,
    private readonly opts: { timeoutMs: number } = { timeoutMs: 10_000 },
  ) {}

  async send(req: SendRequest): Promise<SendOutcome> {
    const { path, body } = this.route(req);
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.opts.timeoutMs),
      });
    } catch (err) {
      return classifyNetworkError(err);
    }

    let json: any = undefined;
    try {
      json = await res.json();
    } catch {
      // Body lost after headers: the status line is still evidence.
      if (res.ok) return { status: 'unknown', code: 'body_lost', httpStatus: res.status };
    }

    if (res.ok) {
      const id = json?.message_id ?? json?.id;
      return id
        ? { status: 'accepted', providerMessageId: String(id), httpStatus: res.status }
        : { status: 'unknown', code: 'missing_message_id', httpStatus: res.status };
    }
    const code = json?.error?.code;
    if (res.status === 401 || AUTH_ERROR_CODES.has(Number(code))) {
      return { status: 'rejected', code: 'unauthorized', httpStatus: res.status };
    }
    if (res.status === 429 || THROTTLE_ERROR_CODES.has(Number(code)) || (res.status === 503 && res.headers.get('x-not-processed') === '1')) {
      return { status: 'not_sent', code: res.status === 503 ? 'unavailable' : 'throttled', retryAfterMs: retryAfterMs(res), httpStatus: res.status };
    }
    if (res.status >= 400 && res.status < 500) {
      return { status: 'rejected', code: String(code ?? res.status), httpStatus: res.status };
    }
    return { status: 'unknown', code: `http_${res.status}`, httpStatus: res.status };
  }

  async lookupByClientRef(accountId: string, clientRef: string): Promise<LookupResult> {
    const res = await fetch(
      `${this.baseUrl}/v1/${encodeURIComponent(accountId)}/messages?client_ref=${encodeURIComponent(clientRef)}`,
      { signal: AbortSignal.timeout(this.opts.timeoutMs) },
    );
    if (!res.ok) throw new Error(`lookup failed: HTTP ${res.status}`);
    const json: any = await res.json();
    const hit = json?.data?.[0];
    return hit ? { found: true, providerMessageId: String(hit.id) } : { found: false };
  }

  private route(req: SendRequest): { path: string; body: unknown } {
    const account = encodeURIComponent(req.accountId);
    switch (req.kind) {
      case 'comment_reply':
        return {
          path: `/v1/${account}/comments/${encodeURIComponent(req.commentId!)}/replies`,
          body: { message: req.text, client_ref: req.clientRef },
        };
      case 'private_reply':
        return { path: `/v1/${account}/messages`, body: { recipient: { comment_id: req.commentId }, message: { text: req.text }, client_ref: req.clientRef } };
      case 'dm':
        return { path: `/v1/${account}/messages`, body: { recipient: { id: req.recipientId }, message: { text: req.text }, client_ref: req.clientRef } };
    }
  }
}

function retryAfterMs(res: Response): number {
  const h = Number(res.headers.get('retry-after'));
  return Number.isFinite(h) && h > 0 ? h * 1000 : 5_000;
}

function classifyNetworkError(err: unknown): SendOutcome {
  const e = err as { name?: string; cause?: { code?: string } };
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return { status: 'unknown', code: 'timeout' };
  const code = e?.cause?.code;
  // The request never reached a server: provably no effect.
  if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return { status: 'not_sent', code: code.toLowerCase(), retryAfterMs: 2_000 };
  }
  return { status: 'unknown', code: 'connection_lost' };
}
