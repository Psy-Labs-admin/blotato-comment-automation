import type { SendOutcome, SendRequest, SocialPlatform } from '../adapters/instagram';
import { PostMetadataSchema, type MetadataClient, type MetadataResult } from '../metadata/client';

export interface InstagramAccountCredential {
  token: string;
  accountId: string;
  connectionId: string;
  tenantId: string;
  tokenVersion: number;
}

export interface InstagramGraphOptions {
  graphVersion: string;
  credentials(accountId: string): Promise<InstagramAccountCredential>;
  timeoutMs?: number;
  /** Isolated transport tests can use a loopback server. Runtime uses Meta's fixed host. */
  graphBaseUrl?: string;
  fetch?: typeof fetch;
}

const authCodes = new Set([102, 190]);
const throttleCodes = new Set([4, 17, 32, 613]);

/** Native Instagram Login Graph operations. Every call represents one visible ledger attempt. */
export class InstagramGraphPlatform implements SocialPlatform, MetadataClient {
  private readonly baseUrl: string;
  private readonly fetch: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly options: InstagramGraphOptions) {
    if (!/^v\d+\.\d+$/.test(options.graphVersion)) throw new Error('A versioned Instagram Graph API is required');
    const url = new URL(options.graphBaseUrl ?? 'https://graph.instagram.com');
    if (url.username || url.password || url.search || url.hash ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))) {
      throw new Error('Invalid Instagram Graph transport URL');
    }
    this.baseUrl = url.toString().replace(/\/$/, '');
    this.fetch = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  async send(request: SendRequest): Promise<SendOutcome> {
    let credential: InstagramAccountCredential;
    try {
      credential = await this.options.credentials(request.accountId);
    } catch {
      return { status: 'not_sent', code: 'credentials_unavailable', retryAfterMs: 30_000 };
    }
    if (credential.accountId !== request.accountId) return { status: 'rejected', code: 'account_mismatch', httpStatus: 401 };
    const route = request.kind === 'comment_reply'
      ? { path: encodeURIComponent(request.commentId ?? '') + '/replies', body: { message: request.text } }
      : { path: encodeURIComponent(credential.accountId) + '/messages', body: {
        recipient: request.kind === 'private_reply' ? { comment_id: request.commentId } : { id: request.recipientId },
        message: { text: request.text },
      } };
    if ((request.kind !== 'dm' && !request.commentId) || (request.kind === 'dm' && !request.recipientId)) {
      return { status: 'rejected', code: 'invalid_recipient', httpStatus: 400 };
    }
    let response: Response;
    try {
      response = await this.fetch(this.baseUrl + '/' + this.options.graphVersion + '/' + route.path, {
        method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(this.timeoutMs),
        headers: { authorization: 'Bearer ' + credential.token, 'content-type': 'application/json' },
        body: JSON.stringify(route.body),
      });
    } catch (error) {
      const code = (error as { cause?: { code?: string } }).cause?.code;
      if (['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'].includes(code ?? '')) {
        return { status: 'not_sent', code: 'connection_unavailable', retryAfterMs: 5_000 };
      }
      return { status: 'unknown', code: 'provider_no_confirmation' };
    }
    let payload: unknown;
    try { payload = await response.json(); } catch { payload = null; }
    const body = payload as { id?: unknown; message_id?: unknown; error?: { code?: unknown } } | null;
    if (response.ok) {
      const id = body?.message_id ?? body?.id;
      return typeof id === 'string' && id.length > 0
        ? { status: 'accepted', providerMessageId: id, httpStatus: response.status }
        : { status: 'unknown', code: 'missing_message_id', httpStatus: response.status };
    }
    if (response.status >= 500 || (response.status >= 300 && response.status < 400)) {
      return { status: 'unknown', code: 'http_' + response.status, httpStatus: response.status };
    }
    const graphCode = Number(body?.error?.code);
    if (response.status === 401 || authCodes.has(graphCode)) return { status: 'rejected', code: 'unauthorized', httpStatus: response.status, credentialGeneration: { connectionId: credential.connectionId, version: credential.tokenVersion } };
    if (response.status === 429 || (response.status === 400 && throttleCodes.has(graphCode))) {
      return { status: 'not_sent', code: 'throttled', retryAfterMs: retryDelay(response), httpStatus: response.status };
    }
    if (response.status >= 400 && response.status < 500) {
      return { status: 'rejected', code: Number.isFinite(graphCode) ? String(graphCode) : 'request_rejected', httpStatus: response.status };
    }
    return { status: 'unknown', code: 'http_' + response.status, httpStatus: response.status };
  }

  async fetchPost(accountId: string, mediaId: string): Promise<MetadataResult> {
    const credential = await this.options.credentials(accountId);
    if (credential.accountId !== accountId) throw new Error('Instagram account credential mismatch');
    const url = new URL(this.baseUrl + '/' + this.options.graphVersion + '/' + encodeURIComponent(mediaId));
    url.searchParams.set('fields', 'id,caption,permalink,media_type');
    const response = await this.fetch(url, {
      headers: { authorization: 'Bearer ' + credential.token }, redirect: 'manual',
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (response.status === 403) return { status: 'denied' };
    if (response.status === 404) return { status: 'not_found' };
    if (!response.ok) throw new Error('Instagram metadata failed: HTTP ' + response.status);
    const body = await response.json() as { caption?: unknown; permalink?: unknown; media_type?: unknown };
    return { status: 'available', metadata: PostMetadataSchema.parse({
      caption: body.caption, permalink: body.permalink, mediaType: body.media_type,
    }) };
  }
}

function retryDelay(response: Response): number {
  const raw = response.headers.get('retry-after');
  if (!raw) return 30_000;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.max(100, seconds * 1000);
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(100, at - Date.now()) : 30_000;
}
