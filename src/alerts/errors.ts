/** Fixed operational codes keep provider descriptions, URLs and credentials out of persisted errors. */
export class NotificationError extends Error {
  constructor(
    public readonly code: string,
    public readonly options: { permanent?: boolean; retryAfterMs?: number; uncertain?: boolean } = {},
  ) {
    super(code);
    this.name = 'NotificationError';
  }
}
