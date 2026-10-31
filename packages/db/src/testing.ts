import { createSql, DEFAULT_DATABASE_URL, migrate } from './client.js';
import type { Sql } from './client.js';

/**
 * Connects to a separate `dispatch_test_<suite>` database (created on first use) with the schema
 * applied. One database per test file: Vitest runs files in parallel, and a shared database would
 * let one file's TRUNCATE wipe another's data mid-test.
 * Returns null when Postgres isn't reachable, so integration tests can skip instead of failing.
 */
export async function createTestSql(suite: string): Promise<Sql | null> {
  if (!/^[a-z_]+$/.test(suite)) throw new Error('suite must be lowercase letters/underscores');
  const name = `dispatch_test_${suite}`;
  const admin = createSql(DEFAULT_DATABASE_URL);
  try {
    const [exists] = await admin`SELECT 1 FROM pg_database WHERE datname = ${name}`;
    if (!exists) await admin.unsafe(`CREATE DATABASE ${name}`);
  } catch {
    return null;
  } finally {
    await admin.end();
  }
  const sql = createSql(DEFAULT_DATABASE_URL.replace(/\/dispatch$/, `/${name}`));
  await migrate(sql);
  return sql;
}
