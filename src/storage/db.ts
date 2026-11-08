import { Pool, type PoolClient } from 'pg';

export type Db = Pool;
export type Tx = PoolClient;

export function createPool(connectionString: string, max = 20): Pool {
  const pool = new Pool({ connectionString, max });
  // A server restart removes idle connections. pg replaces them on the next checkout.
  pool.on('error', (error: Error & { code?: string }) => console.error('Postgres idle connection closed', error.code ?? error.name));
  return pool;
}

/**
 * Runs `fn` in a READ COMMITTED transaction. Invariants are enforced with row locks
 * (SELECT ... FOR UPDATE on the conversation row) and unique constraints, not with
 * SERIALIZABLE retries, so callers get deterministic behaviour under concurrency.
 */
export async function withTx<T>(db: Pool, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
