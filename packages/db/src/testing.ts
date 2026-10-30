import { createSql, DEFAULT_DATABASE_URL, migrate } from './client.js';
import type { Sql } from './client.js';

/**
 * Connects to a separate `dispatch_test` database (created on first use) with the schema applied.
 * Returns null when Postgres isn't reachable, so integration tests can skip instead of failing.
 */
export async function createTestSql(): Promise<Sql | null> {
  const admin = createSql(DEFAULT_DATABASE_URL);
  try {
    const [exists] = await admin`SELECT 1 FROM pg_database WHERE datname = 'dispatch_test'`;
    if (!exists) await admin.unsafe('CREATE DATABASE dispatch_test');
  } catch {
    return null;
  } finally {
    await admin.end();
  }
  const sql = createSql(DEFAULT_DATABASE_URL.replace(/\/dispatch$/, '/dispatch_test'));
  await migrate(sql);
  return sql;
}
