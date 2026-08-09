import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Client } from '@libsql/client';

export type MigrationScope = 'project' | 'global';

/**
 * Migrations live as plain `.sql` files, not embedded strings, so the same
 * files drive the app, `pnpm db:migrate`, and anyone poking at a database by
 * hand. Resolves the same from `src/` (tsx) and `dist/` (built).
 */
export const migrationsDir = (scope: MigrationScope): string =>
  path.join(fileURLToPath(new URL('../migrations/', import.meta.url)), scope);

export const listMigrationFiles = (scope: MigrationScope): string[] =>
  readdirSync(migrationsDir(scope))
    .filter((file) => file.endsWith('.sql'))
    .sort();

const ensureTable = async (client: Client): Promise<void> => {
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
  const files = listMigrationFiles(scope);
  return {
    applied: files.filter((file) => applied.has(file)),
    pending: files.filter((file) => !applied.has(file)),
  };
};

/** Applies every unapplied migration in filename order. Idempotent. */
export const migrate = async (client: Client, scope: MigrationScope): Promise<string[]> => {
  await ensureTable(client);
  const applied = await appliedSet(client);
  const dir = migrationsDir(scope);
  const runNow: string[] = [];

  for (const file of listMigrationFiles(scope)) {
    if (applied.has(file)) continue;
    const sql = readFileSync(path.join(dir, file), 'utf8');
    // executeMultiple runs the whole file; libSQL wraps it in a transaction.
    await client.executeMultiple(sql);
    await client.execute({
      sql: 'INSERT INTO schema_migrations (name) VALUES (?)',
      args: [file],
    });
    runNow.push(file);
  }
  return runNow;
};
