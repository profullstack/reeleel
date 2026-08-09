import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { loadConfig } from './config.js';
import { all, execute, get, globalDb, projectDb, toNumber } from './db.js';
import { ReelEelError, invalidInput } from './errors.js';
import { newId, nowIso, slugify } from './ids.js';
import {
  DERIVED_DIRS,
  MANIFEST_FILENAME,
  PROJECT_DIRS,
  databasePath,
  manifestPath,
  projectDir,
} from './layout.js';
import type { ProjectManifest, ProjectSummary } from './types.js';

import { DEFAULT_SPORT, isKnownSport } from '@reeleel/sports';

export const MANIFEST_FORMAT_VERSION = 1;

export interface CreateProjectInput {
  name: string;
  sport?: string;
  /** Explicit directory. Defaults to `<config projects.dir>/<slug>`. */
  path?: string;
  description?: string;
  opponent?: string;
  gameDate?: string;
  tags?: string[];
}

export interface ProjectUpdate {
  name?: string;
  sport?: string;
  description?: string | null;
  opponent?: string | null;
  gameDate?: string | null;
  tags?: string[];
}

const isManifest = (value: unknown): value is ProjectManifest => {
  if (typeof value !== 'object' || value === null) return false;
  const manifest = value as Partial<ProjectManifest>;
  return typeof manifest.id === 'string' && typeof manifest.name === 'string';
};

export const readManifest = (root: string): ProjectManifest => {
  const file = manifestPath(root);
  if (!existsSync(file)) {
    throw new ReelEelError('PROJECT_NOT_FOUND', `No ReelEel project at ${root}.`, {
      hint: `A project directory contains a ${MANIFEST_FILENAME}. Create one with \`reeleel project create\`.`,
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (cause) {
    throw new ReelEelError('PROJECT_INVALID', `${file} is not valid JSON.`, { cause });
  }
  if (!isManifest(parsed)) {
    throw new ReelEelError('PROJECT_INVALID', `${file} is missing required fields.`);
  }
  if (parsed.formatVersion > MANIFEST_FORMAT_VERSION) {
    throw new ReelEelError(
      'PROJECT_INVALID',
      `${file} was written by a newer ReelEel (format ${parsed.formatVersion}).`,
      { hint: 'Upgrade ReelEel to open this project.' },
    );
  }
  return parsed;
};

export const writeManifest = (root: string, manifest: ProjectManifest): void => {
  writeFileSync(manifestPath(root), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
};

export const isProjectRoot = (dir: string): boolean => existsSync(manifestPath(dir));

/**
 * Walks up from `start` looking for a project.json, so CLI commands work from
 * anywhere inside a project directory the way git does.
 */
export const findProjectRoot = (start: string = process.cwd()): string | null => {
  let current = path.resolve(start);
  for (;;) {
    if (isProjectRoot(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
};

const registerProject = async (manifest: ProjectManifest, root: string): Promise<void> => {
  const db = await globalDb();
  await execute(
    db,
    `INSERT INTO registered_projects (id, root, name, sport, added_at, last_opened_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(root) DO UPDATE SET
       id = excluded.id, name = excluded.name, sport = excluded.sport,
       last_opened_at = excluded.last_opened_at`,
    [manifest.id, root, manifest.name, manifest.sport, nowIso(), nowIso()],
  );
};

export const unregisterProject = async (root: string): Promise<void> => {
  const db = await globalDb();
  await execute(db, 'DELETE FROM registered_projects WHERE root = ?', [path.resolve(root)]);
};

export const touchProject = async (root: string): Promise<void> => {
  const db = await globalDb();
  await execute(db, 'UPDATE registered_projects SET last_opened_at = ? WHERE root = ?', [
    nowIso(),
    path.resolve(root),
  ]);
};

export const createProject = async (
  input: CreateProjectInput,
): Promise<{ root: string; manifest: ProjectManifest }> => {
  const name = input.name.trim();
  if (name.length === 0) throw invalidInput('Project name cannot be empty.');

  const sport = input.sport ?? DEFAULT_SPORT;
  if (!isKnownSport(sport)) {
    throw new ReelEelError('SPORT_UNKNOWN', `"${sport}" is not a supported sport.`, {
      hint: 'Run `reeleel sports list` to see what is available. Soccer ships today.',
    });
  }

  const config = loadConfig();
  const root = path.resolve(input.path ?? path.join(config.projects.dir, slugify(name)));

  if (isProjectRoot(root)) {
    throw new ReelEelError('PROJECT_EXISTS', `${root} already contains a ReelEel project.`, {
      hint: 'Pick another path, or open the existing project.',
    });
  }

  const timestamp = nowIso();
  const manifest: ProjectManifest = {
    formatVersion: MANIFEST_FORMAT_VERSION,
    id: newId('prj'),
    name,
    sport,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  if (input.description !== undefined) manifest.description = input.description;
  if (input.opponent !== undefined) manifest.opponent = input.opponent;
  if (input.gameDate !== undefined) manifest.gameDate = input.gameDate;
  if (input.tags !== undefined && input.tags.length > 0) manifest.tags = input.tags;

  mkdirSync(root, { recursive: true });
  for (const dir of PROJECT_DIRS) mkdirSync(projectDir(root, dir), { recursive: true });
  writeManifest(root, manifest);

  // Opening the project database also runs its migrations, so the project is
  // immediately usable.
  const db = await projectDb(root);
  for (const [key, value] of [
    ['project_id', manifest.id],
    ['sport', manifest.sport],
    ['created_at', manifest.createdAt],
  ]) {
    await execute(db, 'INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', [
      key ?? '',
      value ?? '',
    ]);
  }

  await registerProject(manifest, root);
  return { root, manifest };
};

/**
 * Resolves a project reference to its root directory. Accepts an explicit path,
 * a registered project id, or a registered project name. With no reference at
 * all, walks up from the current directory.
 */
export const resolveProjectRoot = async (reference?: string): Promise<string> => {
  if (reference === undefined || reference.length === 0) {
    const found = findProjectRoot();
    if (found !== null) return found;
    throw new ReelEelError('PROJECT_NOT_FOUND', 'No project given and none found here.', {
      hint: 'Pass a project path, or run inside a project directory.',
    });
  }

  const asPath = path.resolve(reference);
  if (isProjectRoot(asPath)) return asPath;

  const db = await globalDb();
  const match = await get<{ root: string }>(
    db,
    `SELECT root FROM registered_projects
     WHERE id = ? OR name = ? COLLATE NOCASE
     ORDER BY last_opened_at DESC LIMIT 1`,
    [reference, reference],
  );

  if (match !== undefined && isProjectRoot(match.root)) return match.root;

  if (match !== undefined) {
    throw new ReelEelError(
      'PROJECT_NOT_FOUND',
      `Project "${reference}" is registered at ${match.root}, but that directory is gone.`,
      { hint: `Run \`reeleel project remove ${reference} --forget\` to drop the stale entry.` },
    );
  }

  throw new ReelEelError('PROJECT_NOT_FOUND', `No project matched "${reference}".`, {
    hint: 'Run `reeleel project list` to see known projects.',
  });
};

const countRows = async (
  root: string,
): Promise<{ videos: number; athletes: number; moments: number }> => {
  const db = await projectDb(root);
  const one = async (sql: string): Promise<number> => {
    const row = await get<{ n: number | bigint }>(db, sql);
    return toNumber(row?.n ?? 0);
  };
  return {
    videos: await one('SELECT COUNT(*) AS n FROM source_videos'),
    athletes: await one('SELECT COUNT(*) AS n FROM athletes'),
    moments: await one('SELECT COUNT(*) AS n FROM suggested_moments'),
  };
};

export const summarizeProject = async (root: string): Promise<ProjectSummary> => {
  const manifest = readManifest(root);
  const counts = await countRows(root);
  return {
    ...manifest,
    root,
    videoCount: counts.videos,
    athleteCount: counts.athletes,
    momentCount: counts.moments,
    exists: true,
  };
};

export const listProjects = async (): Promise<ProjectSummary[]> => {
  const db = await globalDb();
  const rows = await all<{
    id: string;
    root: string;
    name: string;
    sport: string;
    added_at: string;
  }>(
    db,
    `SELECT id, root, name, sport, added_at, last_opened_at
     FROM registered_projects
     ORDER BY COALESCE(last_opened_at, added_at) DESC`,
  );

  const summaries: ProjectSummary[] = [];
  for (const row of rows) {
    if (!isProjectRoot(row.root)) {
      // Keep stale entries visible so the user can clean them up deliberately.
      summaries.push({
        formatVersion: MANIFEST_FORMAT_VERSION,
        id: row.id,
        name: row.name,
        sport: row.sport,
        createdAt: row.added_at,
        updatedAt: row.added_at,
        root: row.root,
        videoCount: 0,
        athleteCount: 0,
        momentCount: 0,
        exists: false,
      });
      continue;
    }
    summaries.push(await summarizeProject(row.root));
  }
  return summaries;
};

export const updateProject = async (
  root: string,
  patch: ProjectUpdate,
): Promise<ProjectManifest> => {
  const manifest = readManifest(root);

  if (patch.sport !== undefined && !isKnownSport(patch.sport)) {
    throw new ReelEelError('SPORT_UNKNOWN', `"${patch.sport}" is not a supported sport.`, {
      hint: 'Run `reeleel sports list` to see what is available.',
    });
  }
  if (patch.name !== undefined && patch.name.trim().length === 0) {
    throw invalidInput('Project name cannot be empty.');
  }

  const next: ProjectManifest = { ...manifest, updatedAt: nowIso() };
  if (patch.name !== undefined) next.name = patch.name.trim();
  if (patch.sport !== undefined) next.sport = patch.sport;
  if (patch.tags !== undefined) next.tags = patch.tags;

  // `null` clears an optional field; `undefined` leaves it alone.
  const optional = ['description', 'opponent', 'gameDate'] as const;
  for (const key of optional) {
    const value = patch[key];
    if (value === null) delete next[key];
    else if (value !== undefined) next[key] = value;
  }

  writeManifest(root, next);
  await registerProject(next, root);
  return next;
};

export interface RemoveProjectOptions {
  /** Delete the project directory from disk. Without it, only unregister. */
  deleteFiles?: boolean;
  /** Delete regenerable output (proxies, analysis, clips…) but keep the project. */
  derivedOnly?: boolean;
}

export interface RemoveProjectResult {
  root: string;
  unregistered: boolean;
  deletedPaths: string[];
}

export const removeProject = async (
  root: string,
  options: RemoveProjectOptions = {},
): Promise<RemoveProjectResult> => {
  const resolved = path.resolve(root);

  if (options.derivedOnly === true) {
    const deleted: string[] = [];
    for (const dir of DERIVED_DIRS) {
      const target = projectDir(resolved, dir);
      if (!existsSync(target)) continue;
      rmSync(target, { recursive: true, force: true });
      mkdirSync(target, { recursive: true });
      deleted.push(target);
    }
    return { root: resolved, unregistered: false, deletedPaths: deleted };
  }

  await unregisterProject(resolved);

  if (options.deleteFiles !== true) {
    return { root: resolved, unregistered: true, deletedPaths: [] };
  }

  // Guard against `rm -rf` on a directory that is not actually a project.
  if (!existsSync(manifestPath(resolved)) && !existsSync(databasePath(resolved))) {
    throw new ReelEelError(
      'PROJECT_INVALID',
      `${resolved} does not look like a ReelEel project; refusing to delete it.`,
    );
  }

  rmSync(resolved, { recursive: true, force: true });
  return { root: resolved, unregistered: true, deletedPaths: [resolved] };
};

/** Adds an existing on-disk project to this machine's registry. */
export const importProject = async (root: string): Promise<ProjectManifest> => {
  const resolved = path.resolve(root);
  const manifest = readManifest(resolved);
  await registerProject(manifest, resolved);
  return manifest;
};
