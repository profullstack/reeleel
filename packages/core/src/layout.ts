import { homedir } from 'node:os';
import path from 'node:path';

/**
 * A ReelEel project is a portable directory. Nothing outside it is required to
 * reopen a game, so a project can be moved between machines or backed up as-is.
 *
 *   project/
 *   ├── project.json     portable manifest (human readable, diffable)
 *   ├── project.db       SQLite: jobs, detections, tracks, moments, clips…
 *   ├── source/          imported media (usually referenced in place, not copied)
 *   ├── proxies/         low-res editing proxies
 *   ├── thumbnails/      scrub thumbnails and poster frames
 *   ├── analysis/        detector/tracker intermediate output
 *   ├── annotations/     human corrections and dataset exports
 *   ├── clips/           rendered clip segments
 *   ├── models/          project-pinned model copies
 *   └── exports/         finished reels
 */
export const PROJECT_DIRS = [
  'source',
  'proxies',
  'thumbnails',
  'analysis',
  'annotations',
  'clips',
  'models',
  'exports',
] as const;

export type ProjectDir = (typeof PROJECT_DIRS)[number];

export const MANIFEST_FILENAME = 'project.json';
export const DATABASE_FILENAME = 'project.db';

/** Directories wiped by `reeleel project clean` / `project remove --derived-only`. */
export const DERIVED_DIRS: readonly ProjectDir[] = [
  'proxies',
  'thumbnails',
  'analysis',
  'clips',
  'exports',
];

export const manifestPath = (root: string): string => path.join(root, MANIFEST_FILENAME);
export const databasePath = (root: string): string => path.join(root, DATABASE_FILENAME);
export const projectDir = (root: string, dir: ProjectDir): string => path.join(root, dir);

const xdg = (envVar: string, fallback: string): string => {
  const fromEnv = process.env[envVar];
  return fromEnv !== undefined && fromEnv.length > 0
    ? path.join(fromEnv, 'reeleel')
    : path.join(homedir(), fallback, 'reeleel');
};

/** `$REELEEL_HOME` overrides everything — tests and portable installs rely on it. */
const overrideHome = (): string | undefined => {
  const home = process.env['REELEEL_HOME'];
  return home !== undefined && home.length > 0 ? home : undefined;
};

/** Config: user settings (`config.json`). */
export const configHome = (): string =>
  overrideHome() ?? xdg('XDG_CONFIG_HOME', path.join('.config'));

/** Data: project registry, model registry, downloaded weights. */
export const dataHome = (): string =>
  overrideHome() ?? xdg('XDG_DATA_HOME', path.join('.local', 'share'));

/** Cache: throwaway derived media that can always be regenerated. */
export const cacheHome = (): string =>
  overrideHome() ?? xdg('XDG_CACHE_HOME', path.join('.cache'));

export const configFilePath = (): string => path.join(configHome(), 'config.json');
export const globalDatabasePath = (): string => path.join(dataHome(), 'reeleel.db');
export const modelStorePath = (): string => path.join(dataHome(), 'models');
