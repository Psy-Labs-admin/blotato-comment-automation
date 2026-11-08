import { z } from 'zod';

export const PostMetadataSchema = z.object({
  caption: z.string().max(10000).optional(),
  permalink: z.string().url().refine((value) => ['http:', 'https:'].includes(new URL(value).protocol)).optional(),
  mediaType: z.enum(['IMAGE', 'VIDEO', 'CAROUSEL_ALBUM']).optional(),
});
export type PostMetadata = z.infer<typeof PostMetadataSchema>;
export type MetadataResult = { status: 'available'; metadata: PostMetadata } | { status: 'denied' | 'not_found' };

export interface MetadataClient {
  fetchPost(accountId: string, mediaId: string): Promise<MetadataResult>;
}

/** Reads the existing integration's normalized metadata contract. */
export class HttpMetadataClient implements MetadataClient {
  constructor(private readonly baseUrl: string, private readonly timeoutMs = 5000, private readonly token?: string) {}

  async fetchPost(accountId: string, mediaId: string): Promise<MetadataResult> {
    const response = await fetch(`${this.baseUrl}/v1/${encodeURIComponent(accountId)}/media/${encodeURIComponent(mediaId)}`, {
      redirect: 'error',
      headers: this.token ? { authorization: 'Bearer ' + this.token } : {},
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (response.status === 403) return { status: 'denied' };
    if (response.status === 404) return { status: 'not_found' };
    if (!response.ok) throw new Error(`Post metadata failed: HTTP ${response.status}`);
    return { status: 'available', metadata: PostMetadataSchema.parse(await response.json()) };
  }
}
