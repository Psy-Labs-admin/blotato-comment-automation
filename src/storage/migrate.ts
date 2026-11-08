import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Pool } from 'pg';
import { createPool, withTx } from './db';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');

/** Applies migrations/*.sql in lexical order, once each, inside a transaction per file. */
export async function migrate(db: Pool): Promise<string[]> {
  await withTx(db, async (c) => {
    // The migration ledger itself must be protected during a fresh concurrent startup.
    await c.query(`SELECT pg_advisory_xact_lock(4242)`);
    await c.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
    );
  });
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  const applied: string[] = [];
  for (const file of files) {
    await withTx(db, async (c) => {
      // Serialise concurrent migrators (e.g. API and worker starting together).
      await c.query(`SELECT pg_advisory_xact_lock(4242)`);
      const done = await c.query(`SELECT 1 FROM schema_migrations WHERE name = $1`, [file]);
      if (done.rowCount) return;
      await c.query(readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
      await c.query(`INSERT INTO schema_migrations (name) VALUES ($1)`, [file]);
      applied.push(file);
    });
  }
  return applied;
}

if (require.main === module) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  const db = createPool(url, 1);
  migrate(db)
    .then((applied) => console.log(applied.length ? `applied: ${applied.join(', ')}` : 'up to date'))
    .finally(() => db.end());
}
