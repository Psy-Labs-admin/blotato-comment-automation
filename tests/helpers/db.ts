import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { migrate } from '../../src/storage/migrate';

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ?? 'postgres://postgres:postgres@localhost:55432/postgres';

/** One throw-away database per test file: real Postgres semantics, no cross-test bleed. */
export async function createTestDb(): Promise<{ db: Pool; url: string; drop(): Promise<void> }> {
  const name = `test_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const admin = new Pool({ connectionString: ADMIN_URL, max: 1 });
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(ADMIN_URL);
  url.pathname = `/${name}`;
  const db = new Pool({ connectionString: url.toString(), max: 20 });
  await migrate(db);
  return {
    db,
    url: url.toString(),
    async drop() {
      await db.end();
      await admin.query(`DROP DATABASE IF EXISTS ${name}`);
      await admin.end();
    },
  };
}
