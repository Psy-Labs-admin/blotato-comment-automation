export interface AlertNotifier {
  notify(text: string): Promise<void>;
}

/** Telegram Bot API delivery for grouped incidents. Texts never contain message bodies or emails. */
export class TelegramNotifier implements AlertNotifier {
  constructor(
    private readonly token: string,
    private readonly chatId: string,
    private readonly apiBase = 'https://api.telegram.org',
  ) {}

  async notify(text: string): Promise<void> {
    const res = await fetch(`${this.apiBase}/bot${this.token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: this.chatId, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) throw new Error(`Telegram sendMessage failed: HTTP ${res.status}`);
  }
}

/** Generic webhook sink (used with the local fake when Telegram is not configured). */
export class HttpAlertSink implements AlertNotifier {
  constructor(private readonly url: string) {}

  async notify(text: string): Promise<void> {
    const res = await fetch(`${this.url}/alerts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) throw new Error(`alert sink failed: HTTP ${res.status}`);
  }
}
