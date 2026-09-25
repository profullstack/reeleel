#!/usr/bin/env node
// Forward-only migration runner.
//
//   pnpm db:migrate                                   # machine registry
//   pnpm db:migrate --scope project --path ./my-game/project.db
//   pnpm db:migrate --status
//
// The registry is Postgres when DATABASE_URL (postgres://) is set and applies
// packages/db/migrations-pg/global through @profullstack/libsql-pg; otherwise
// it is the local libSQL file (REELEEL_DB_PATH, or the default under
// REELEEL_HOME / XDG_DATA_HOME) and applies packages/db/migrations/global.
// Project databases are always local files. The retired REELEEL_DB_URL (Turso)
// is refused with the copy recipe; the SQLite migrations stay in the tree so
// the old registry can still be read until the cutover is proven.
import { readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback);
};

const scope = arg('scope', 'global');
if (!['global', 'project'].includes(scope)) {
  console.error(`--scope must be "global" or "project", got "${scope}".`);
  process.exit(1);
}

const statusOnly = process.argv.includes('--status');

const defaultGlobalPath = () => {
  const home = process.env.REELEEL_HOME;
  if (home) return path.join(home, 'reeleel.db');
  const data = process.env.XDG_DATA_HOME ?? path.join(homedir(), '.local', 'share');
  return path.join(data, 'reeleel', 'reeleel.db');
};

const explicitPath = arg('path', undefined);
if (scope === 'project' && !explicitPath) {
  console.error('--scope project requires --path <project.db>.');
  process.exit(1);
}

if (process.env.REELEEL_DB_URL) {
  console.error(
    'REELEEL_DB_URL is no longer read: the registry moved from Turso to Postgres.\n' +
      'Copy it with: npx libsql-pg copy --from "$REELEEL_DB_URL" --token "$REELEEL_DB_AUTH_TOKEN" --to "$DATABASE_URL" --verify\n' +
      'then set DATABASE_URL and unset REELEEL_DB_URL.',
  );
  process.exit(1);
}

const pgUrl = scope === 'global' && !explicitPath ? process.env.DATABASE_URL : undefined;
if (pgUrl && !/^postgres(ql)?:\/\//i.test(pgUrl)) {
  console.error(`DATABASE_URL must be postgres:// or postgresql://, got "${pgUrl.split(':')[0]}:".`);
  process.exit(1);
}

const dir = path.join(ROOT, pgUrl ? 'packages/db/migrations-pg' : 'packages/db/migrations', scope);
const files = readdirSync(dir)
  .filter((file) => file.endsWith('.sql'))
  .sort();

const report = (applied) => {
  for (const file of files) {
    console.log(`${applied.has(file) ? '✓ applied' : '• pending'}  ${file}`);
  }
};

if (pgUrl) {
  const { createClient } = await import('@profullstack/libsql-pg');
  const client = createClient({ url: pgUrl, dialect: 'postgres' });
  const pool = client.pool;
  await pool.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       name       TEXT PRIMARY KEY,
       applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
     )`,
  );
  const applied = new Set((await pool.query('SELECT name FROM schema_migrations')).rows.map((row) => row.name));
  if (statusOnly) {
    report(applied);
    await client.close();
    process.exit(0);
  }
  let count = 0;
  for (const file of files) {
    if (applied.has(file)) {
      console.log('• skip    ', file);
      continue;
    }
    const conn = await pool.connect();
    try {
      await conn.query('BEGIN');
      await conn.query(readFileSync(path.join(dir, file), 'utf8'));
      await conn.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      await conn.query('COMMIT');
    } catch (error) {
      await conn.query('ROLLBACK').catch(() => {});
      console.error(`✗ failed   ${file}: ${error.message}`);
      await client.close();
      process.exit(1);
    } finally {
      conn.release();
    }
    console.log('✓ applied ', file);
    count += 1;
  }
  console.log(count === 0 ? 'Already up to date.' : `Applied ${count} migration(s).`);
  await client.close();
} else {
  const { createClient } = await import('@libsql/client');
  const filePath = explicitPath ?? process.env.REELEEL_DB_PATH ?? defaultGlobalPath();
  const db = createClient({ url: `file:${filePath.replace(/^file:/, '')}` });

  await db.execute(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       name       TEXT PRIMARY KEY,
       applied_at TEXT NOT NULL DEFAULT (datetime('now'))
     )`,
  );
  const applied = new Set(
    (await db.execute('SELECT name FROM schema_migrations')).rows.map((row) => row.name),
  );
  if (statusOnly) {
    report(applied);
    process.exit(0);
  }
  let count = 0;
  for (const file of files) {
    if (applied.has(file)) {
      console.log('• skip    ', file);
      continue;
    }
    await db.executeMultiple(readFileSync(path.join(dir, file), 'utf8'));
    await db.execute({ sql: 'INSERT INTO schema_migrations (name) VALUES (?)', args: [file] });
    console.log('✓ applied ', file);
    count += 1;
  }
  console.log(count === 0 ? 'Already up to date.' : `Applied ${count} migration(s).`);
}
