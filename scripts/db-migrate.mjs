#!/usr/bin/env node
// Forward-only libSQL/Turso migration runner.
//
//   pnpm db:migrate                       # global database
//   pnpm db:migrate --scope project --path ./my-game/project.db
//   pnpm db:migrate --status
//
// Config from env (Doppler/.env):
//   REELEEL_DB_URL + REELEEL_DB_AUTH_TOKEN   Turso
//   REELEEL_DB_PATH                          local file (default)
import { createClient } from '@libsql/client';
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
const dir = path.join(ROOT, 'packages/db/migrations', scope);

const defaultGlobalPath = () => {
  const home = process.env.REELEEL_HOME;
  if (home) return path.join(home, 'reeleel.db');
  const data = process.env.XDG_DATA_HOME ?? path.join(homedir(), '.local', 'share');
  return path.join(data, 'reeleel', 'reeleel.db');
};

const clientFromEnv = () => {
  const explicit = arg('path', undefined);
  if (explicit) return createClient({ url: `file:${explicit.replace(/^file:/, '')}` });

  if (scope === 'project') {
    console.error('--scope project requires --path <project.db>.');
    process.exit(1);
  }

  const filePath = process.env.REELEEL_DB_PATH;
  if (filePath) return createClient({ url: `file:${filePath.replace(/^file:/, '')}` });

  const url = process.env.REELEEL_DB_URL;
  if (!url) return createClient({ url: `file:${defaultGlobalPath()}` });

  if (url.startsWith('file:') || url.startsWith('./') || url.startsWith('/')) {
    return createClient({ url: url.startsWith('file:') ? url : `file:${url}` });
  }

  const authToken = process.env.REELEEL_DB_AUTH_TOKEN;
  if (!authToken) {
    console.error('A remote REELEEL_DB_URL requires REELEEL_DB_AUTH_TOKEN.');
    process.exit(1);
  }
  return createClient({ url, authToken });
};

const db = clientFromEnv();

await db.execute(
  `CREATE TABLE IF NOT EXISTS schema_migrations (
     name       TEXT PRIMARY KEY,
     applied_at TEXT NOT NULL DEFAULT (datetime('now'))
   )`,
);

const applied = new Set(
  (await db.execute('SELECT name FROM schema_migrations')).rows.map((row) => row.name),
);
const files = readdirSync(dir)
  .filter((file) => file.endsWith('.sql'))
  .sort();

if (statusOnly) {
  for (const file of files) {
    console.log(`${applied.has(file) ? '✓ applied' : '• pending'}  ${file}`);
  }
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
