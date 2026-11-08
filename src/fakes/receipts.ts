import { DatabaseSync } from 'node:sqlite';

/** Local simulator receipts survive a full demo restart independently of the application's ledger. */
export class DemoReceipts {
  private readonly db: DatabaseSync;
  constructor(filename: string) {
    this.db = new DatabaseSync(filename);
    this.db.exec('CREATE TABLE IF NOT EXISTS receipts (service TEXT, id TEXT, body TEXT NOT NULL, PRIMARY KEY(service, id))');
  }

  read<T>(service: string): Array<[string, T]> {
    return this.db.prepare('SELECT id, body FROM receipts WHERE service = ? ORDER BY rowid').all(service)
      .map((r) => [String(r.id), JSON.parse(String(r.body)) as T]);
  }

  put(service: string, id: string, body: unknown): void {
    this.db.prepare('INSERT INTO receipts VALUES (?, ?, ?) ON CONFLICT(service,id) DO UPDATE SET body = excluded.body')
      .run(service, id, JSON.stringify(body));
  }

  clear(service: string): void { this.db.prepare('DELETE FROM receipts WHERE service = ?').run(service); }
  close(): void { this.db.close(); }
}
