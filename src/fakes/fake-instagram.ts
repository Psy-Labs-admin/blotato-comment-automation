import type { DemoReceipts } from './receipts';
import { randomUUID } from 'node:crypto';
import type { SendKind } from '../domain/types';
import type { MetadataResult } from '../metadata/client';
import { sendJson, startServer } from './http';

/**
 * A fake of the *existing* Instagram send integration, shaped loosely after the Graph API.
 * Its value is fault injection with real sockets: `accept_then_drop` stores the message and then
 * destroys the connection, so the caller experiences exactly what happens when Instagram accepted
 * a DM but the acknowledgement was lost. A mocked `throw new Error('timeout')` cannot prove that.
 *
 * Fake contract (documented assumption, not Meta behaviour): requests carry `client_ref`, and
 * `GET /v1/:account/messages?client_ref=` is an authoritative lookup. Real Instagram offers no such
 * idempotency key, so the real adapter declares `reconciliation: 'none'` and unknowns go to an operator.
 */

export type FaultMode =
  | 'ok'
  | 'reject_permanent'
  | 'unauthorized'
  | 'rate_limit'
  | 'unavailable'
  | 'accept_then_drop'
  | 'accept_then_500'
  | 'delay'
  | 'error';

export interface Fault {
  mode: FaultMode;
  delayMs?: number;
  /** For mode 'error': the HTTP status and Graph API error code to return (nothing is stored). */
  httpStatus?: number;
  code?: number;
  /** Only apply to this kind of send; other kinds pass through. */
  kind?: SendKind;
  /** Only apply when the message text contains this substring. */
  textIncludes?: string;
}

export interface SentMessage {
  id: string;
  kind: SendKind;
  accountId: string;
  commentId?: string;
  recipientId?: string;
  text: string;
  clientRef?: string;
  at: string;
}

export interface FakeInstagram {
  url: string;
  sent(): SentMessage[];
  pushFault(f: Fault): void;
  setPostMetadata(accountId: string, mediaId: string, result: MetadataResult): void;
  metadataRequests(): Array<{ accountId: string; mediaId: string }>;
  reset(): void;
  close(): Promise<void>;
}

export async function startFakeInstagram(port = 0, receipts?: DemoReceipts): Promise<FakeInstagram> {
  let sent: SentMessage[] = receipts?.read<SentMessage>('instagram').map(([, message]) => message) ?? [];
  let faults: Fault[] = [];
  const posts = new Map<string, MetadataResult>();
  let metadataRequests: Array<{ accountId: string; mediaId: string }> = [];
  const postKey = (accountId: string, mediaId: string) => JSON.stringify([accountId, mediaId]);

  const takeFault = (kind: SendKind, text: string): Fault => {
    const i = faults.findIndex((f) => (!f.kind || f.kind === kind) && (!f.textIncludes || text.includes(f.textIncludes)));
    if (i < 0) return { mode: 'ok' };
    return faults.splice(i, 1)[0];
  };

  const server = await startServer(async (req, res, body, url) => {
    const parts = url.pathname.split('/').filter(Boolean);

    if (parts[0] === '__control') {
      if (req.method === 'POST' && parts[1] === 'faults') {
        faults.push(body as Fault);
        return sendJson(res, 200, { queued: faults.length });
      }
      if (req.method === 'GET' && parts[1] === 'sent') return sendJson(res, 200, sent);
      if (req.method === 'POST' && parts[1] === 'reset') {
        receipts?.clear('instagram');
        sent = [];
        faults = [];
        posts.clear();
        metadataRequests = [];
        return sendJson(res, 200, { ok: true });
      }
    }

    // Existing integration metadata contract, independent of send fault injection.
    if (req.method === 'GET' && parts[0] === 'v1' && parts[2] === 'media' && parts[3]) {
      const accountId = decodeURIComponent(parts[1]);
      const mediaId = decodeURIComponent(parts[3]);
      metadataRequests.push({ accountId, mediaId });
      const result = posts.get(postKey(accountId, mediaId)) ?? {
        status: 'available', metadata: { caption: `Demo post ${mediaId}`, mediaType: 'IMAGE' },
      };
      if (result.status === 'available') return sendJson(res, 200, result.metadata);
      return sendJson(res, result.status === 'denied' ? 403 : 404, { error: 'post unavailable' });
    }

    // GET /v1/:account/messages?client_ref=...
    if (req.method === 'GET' && parts[0] === 'v1' && parts[2] === 'messages') {
      const ref = url.searchParams.get('client_ref');
      const hit = sent.filter((m) => m.accountId === parts[1] && m.clientRef === ref);
      return sendJson(res, 200, { data: hit.map((m) => ({ id: m.id })) });
    }

    // POST /v1/:account/comments/:commentId/replies    (public comment reply)
    // POST /v1/:account/messages                        (private reply: recipient.comment_id; DM: recipient.id)
    let msg: Omit<SentMessage, 'id' | 'at'> | undefined;
    if (req.method === 'POST' && parts[0] === 'v1' && parts[2] === 'comments' && parts[4] === 'replies') {
      msg = { kind: 'comment_reply', accountId: parts[1], commentId: parts[3], text: body?.message, clientRef: body?.client_ref };
    } else if (req.method === 'POST' && parts[0] === 'v1' && parts[2] === 'messages') {
      const r = body?.recipient ?? {};
      msg = r.comment_id
        ? { kind: 'private_reply', accountId: parts[1], commentId: r.comment_id, text: body?.message?.text, clientRef: body?.client_ref }
        : { kind: 'dm', accountId: parts[1], recipientId: r.id, text: body?.message?.text, clientRef: body?.client_ref };
    }
    if (!msg) return sendJson(res, 404, { error: { message: 'not found' } });

    const fault = takeFault(msg.kind, msg.text ?? '');
    const record = () => {
      const stored: SentMessage = { ...msg!, id: `mid_${randomUUID().slice(0, 12)}`, at: new Date().toISOString() };
      receipts?.put('instagram', stored.id, stored);
      sent.push(stored);
      return stored;
    };

    switch (fault.mode) {
      case 'ok': {
        const m = record();
        return sendJson(res, 200, { message_id: m.id, recipient_id: m.recipientId ?? null });
      }
      case 'reject_permanent':
        return sendJson(res, 400, { error: { code: 551, type: 'OAuthException', message: "This person isn't available right now." } });
      case 'unauthorized':
        return sendJson(res, 401, { error: { code: 190, type: 'OAuthException', message: 'Error validating access token' } });
      case 'rate_limit':
        return sendJson(res, 429, { error: { code: 4, message: 'Application request limit reached' } }, { 'retry-after': '1' });
      case 'unavailable':
        return sendJson(res, 503, { error: { message: 'temporarily unavailable' } }, { 'x-not-processed': '1', 'retry-after': '1' });
      case 'accept_then_drop':
        record();
        res.socket?.destroy();
        return;
      case 'accept_then_500':
        record();
        return sendJson(res, 500, { error: { message: 'internal error' } });
      case 'error':
        return sendJson(res, fault.httpStatus ?? 400, { error: { code: fault.code ?? 100, message: 'injected error' } });
      case 'delay': {
        const m = record();
        await new Promise((r) => setTimeout(r, fault.delayMs ?? 1000));
        if (res.socket?.destroyed) return;
        return sendJson(res, 200, { message_id: m.id, recipient_id: m.recipientId ?? null });
      }
    }
  }, port);

  return {
    url: server.url,
    sent: () => [...sent],
    pushFault: (f) => faults.push(f),
    setPostMetadata: (accountId, mediaId, result) => posts.set(postKey(accountId, mediaId), result),
    metadataRequests: () => [...metadataRequests],
    reset: () => {
      receipts?.clear('instagram');
      sent = [];
      faults = [];
      posts.clear();
      metadataRequests = [];
    },
    close: server.close,
  };
}
