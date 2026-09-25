import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Client } from '@libsql/client';

import { isPostgresClient } from './client.js';

export type MigrationScope = 'project' | 'global';
export type MigrationDialect = 'sqlite' | 'postgres';

/**
 * Migrations live as plain `.sql` files, not embedded strings, so the same
 * files drive the app, `pnpm db:migrate`, and anyone poking at a database by
 * hand. Resolves the same from `src/` (tsx) and `dist/` (built).
 *
 * `migrations/` is SQLite (every project database, and a local registry);
 * `migrations-pg/` is the Postgres rendering of the global scope, generated
 * with `npx libsql-pg convert-schema` and reviewed. Only the global scope has
 * a Postgres side: project databases are always local files.
 */
export const migrationsDir = (scope: MigrationScope, dialect: MigrationDialect = 'sqlite'): string =>
  path.join(
    fileURLToPath(new URL(dialect === 'postgres' ? '../migrations-pg/' : '../migrations/', import.meta.url)),
    scope,
  );

export const listMigrationFiles = (scope: MigrationScope, dialect: MigrationDialect = 'sqlite'): string[] =>
  readdirSync(migrationsDir(scope, dialect))
    .filter((file) => file.endsWith('.sql'))
    .sort();

const dialectOf = (client: Client): MigrationDialect =>
  isPostgresClient(client) ? 'postgres' : 'sqlite';

/** The pg pool @profullstack/libsql-pg exposes, for running a whole file at once. */
const poolOf = (client: Client): { query: (sql: string) => Promise<unknown> } =>
  (client as unknown as { pool: { query: (sql: string) => Promise<unknown> } }).pool;

const ensureTable = async (client: Client): Promise<void> => {
  if (isPostgresClient(client)) {
    await poolOf(client).query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         name       TEXT PRIMARY KEY,
         applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
       )`,
    );
    return;
  }
  await client.execute(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       name       TEXT PRIMARY KEY,
       applied_at TEXT NOT NULL DEFAULT (datetime('now'))
     )`,
  );
};

const appliedSet = async (client: Client): Promise<Set<string>> => {
  const result = await client.execute('SELECT name FROM schema_migrations');
  return new Set(result.rows.map((row) => String(row['name'])));
};

export interface MigrationStatus {
  applied: string[];
  pending: string[];
}

export const migrationStatus = async (
  client: Client,
  scope: MigrationScope,
): Promise<MigrationStatus> => {
  await ensureTable(client);
  const applied = await appliedSet(client);
  const files = listMigrationFiles(scope, dialectOf(client));
  return {
    applied: files.filter((file) => applied.has(file)),
    pending: files.filter((file) => !applied.has(file)),
  };
};

/**
 * Applies every unapplied migration in filename order. Idempotent. Picks the
 * SQLite or Postgres rendering from the client it is given.
 */
export const migrate = async (client: Client, scope: MigrationScope): Promise<string[]> => {
  const dialect = dialectOf(client);
  if (dialect === 'postgres' && scope === 'project') {
    throw new Error('Project databases are local libSQL files; there is no Postgres rendering of the project scope.');
  }
  await ensureTable(client);
  const applied = await appliedSet(client);
  const dir = migrationsDir(scope, dialect);
  const runNow: string[] = [];

  for (const file of listMigrationFiles(scope, dialect)) {
    if (applied.has(file)) continue;
    const sql = readFileSync(path.join(dir, file), 'utf8');
    if (dialect === 'postgres') {
      // Already Postgres SQL: run the whole file in one round trip, as written,
      // rather than through the per-statement SQLite rewriter.
      await poolOf(client).query(sql);
    } else {
      // executeMultiple runs the whole file; libSQL wraps it in a transaction.
      await client.executeMultiple(sql);
    }
    await client.execute({
      sql: 'INSERT INTO schema_migrations (name) VALUES (?)',
      args: [file],
    });
    runNow.push(file);
  }
  return runNow;
};
