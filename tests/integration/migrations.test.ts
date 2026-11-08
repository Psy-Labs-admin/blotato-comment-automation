import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { expect, it } from 'vitest';
import { migrate } from '../../src/storage/migrate';

it('serializes migration ledger creation and applies each migration once on a fresh concurrent startup', async () => {
  const adminUrl = process.env.DATABASE_ADMIN_URL ?? 'postgres://postgres:postgres@localhost:55432/postgres';
  const name = `test_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  const db = new Pool({ connectionString: url.toString(), max: 8 });
  try {
    const runs = await Promise.all(Array.from({ length: 8 }, () => migrate(db)));
    const applied = runs.flat();
    expect(new Set(applied).size).toBe(applied.length);
    expect(applied).toContain('001_init.sql');
    expect(applied).toContain('002_outbox_claims.sql');
    expect(await migrate(db)).toEqual([]);
  } finally {
    await db.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  }
});
