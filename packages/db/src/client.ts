import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

export type Sql = postgres.Sql;

export const DEFAULT_DATABASE_URL = 'postgres://dispatch:dispatch@localhost:5432/dispatch';

export function createSql(url = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL): Sql {
  return postgres(url, {
    max: 10,
    transform: postgres.camel, // snake_case columns ↔ camelCase fields
    onnotice: () => {}, // silence "relation already exists, skipping" from IF NOT EXISTS
  });
}

const SCHEMA_PATH = fileURLToPath(new URL('../schema.sql', import.meta.url));

/**
 * Applies schema.sql. Every statement is IF NOT EXISTS, so this is safe on every startup.
 * (Docker's /docker-entrypoint-initdb.d only runs on an empty volume, so it can't be relied on.)
 * An advisory lock stops two services migrating at the same moment.
 */
export async function migrate(sql: Sql): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(726354)`;
    await tx.unsafe(readFileSync(SCHEMA_PATH, 'utf8'));
  });
}
