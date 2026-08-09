import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createFileClient } from './client.js';
import { listMigrationFiles, migrate, migrationStatus } from './migrate.js';
import type { Client } from './client.js';

let dir: string;
let db: Client;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'reeleel-db-'));
  db = createFileClient(path.join(dir, 'test.db'));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('migrations', () => {
  it('ships at least one migration per scope', () => {
    expect(listMigrationFiles('project').length).toBeGreaterThan(0);
    expect(listMigrationFiles('global').length).toBeGreaterThan(0);
  });

  it('applies every pending migration', async () => {
    const applied = await migrate(db, 'project');
    expect(applied).toEqual(listMigrationFiles('project'));

    const status = await migrationStatus(db, 'project');
    expect(status.pending).toEqual([]);
    expect(status.applied).toEqual(listMigrationFiles('project'));
  });

  it('is idempotent — a second run applies nothing', async () => {
    await migrate(db, 'project');
    expect(await migrate(db, 'project')).toEqual([]);
  });

  it('creates the tables the core services query', async () => {
    await migrate(db, 'project');
    const result = await db.execute(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    );
    const tables = result.rows.map((row) => String(row['name']));

    for (const table of [
      'source_videos',
      'athletes',
      'jobs',
      'tracks',
      'track_points',
      'annotations',
      'suggested_moments',
      'clips',
      'reels',
      'reel_clips',
      'exports',
    ]) {
      expect(tables).toContain(table);
    }
  });

  it('keeps the global scope separate from the project scope', async () => {
    await migrate(db, 'global');
    const result = await db.execute(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    );
    const tables = result.rows.map((row) => String(row['name']));

    expect(tables).toContain('registered_projects');
    expect(tables).toContain('models');
    // A global database must not carry project tables.
    expect(tables).not.toContain('suggested_moments');
  });

  it('records applied migrations by filename so new files can be added later', async () => {
    await migrate(db, 'global');
    const result = await db.execute('SELECT name FROM schema_migrations');
    expect(result.rows.map((row) => String(row['name']))).toEqual(listMigrationFiles('global'));
  });
});
