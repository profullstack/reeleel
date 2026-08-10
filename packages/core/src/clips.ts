import { existsSync, rmSync } from 'node:fs';

import { all, changes, execute, get, projectDb, toNumber } from './db.js';
import { invalidInput, notFound } from './errors.js';
import { newId, nowIso } from './ids.js';
import { listMoments } from './moments.js';
import { readManifest } from './projects.js';
import { CAMERA_MODES } from './types.js';
import type { CameraMode, Clip } from './types.js';

interface ClipRow {
  id: string;
  project_id: string;
  moment_id: string | null;
  manual: number;
  video_id: string | null;
  start_ts: number;
  end_ts: number;
  sort_order: number;
  camera_mode: CameraMode;
  title: string | null;
  rendered_path: string | null;
  created_at: string;
  updated_at: string;
}

const toClip = (row: ClipRow): Clip => ({
  id: row.id,
  projectId: row.project_id,
  momentId: row.moment_id,
  manual: toNumber(row.manual) === 1,
  videoId: row.video_id,
  start: toNumber(row.start_ts),
  end: toNumber(row.end_ts),
  order: toNumber(row.sort_order),
  cameraMode: row.camera_mode,
  title: row.title,
  renderedPath: row.rendered_path,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export const isCameraMode = (value: string): value is CameraMode =>
  (CAMERA_MODES as readonly string[]).includes(value);

export interface AddClipInput {
  start: number;
  end: number;
  videoId?: string | null;
  momentId?: string | null;
  /** A clip the user made or kept, which regeneration must not delete. */
  manual?: boolean;
  cameraMode?: CameraMode;
  title?: string;
  order?: number;
}

export const addClip = async (root: string, input: AddClipInput): Promise<Clip> => {
  if (input.end <= input.start) throw invalidInput('Clip end must be after its start.');

  const manifest = readManifest(root);
  const db = await projectDb(root);
  const id = newId('clp');
  const timestamp = nowIso();

  const maxRow = await get<{ n: number }>(
    db,
    'SELECT COALESCE(MAX(sort_order), -1) AS n FROM clips',
  );

  await execute(
    db,
    `INSERT INTO clips
       (id, project_id, moment_id, video_id, start_ts, end_ts, sort_order, camera_mode, title, manual, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      manifest.id,
      input.momentId ?? null,
      input.videoId ?? null,
      input.start,
      input.end,
      input.order ?? toNumber(maxRow?.n ?? -1) + 1,
      input.cameraMode ?? 'follow-player',
      input.title ?? null,
      input.manual === true ? 1 : 0,
      timestamp,
      timestamp,
    ],
  );

  const row = await get<ClipRow>(db, 'SELECT * FROM clips WHERE id = ?', [id]);
  if (row === undefined) throw notFound('Clip', id);
  return toClip(row);
};

export const listClips = async (root: string): Promise<Clip[]> => {
  const db = await projectDb(root);
  const rows = await all<ClipRow>(db, 'SELECT * FROM clips ORDER BY sort_order, created_at');
  return rows.map(toClip);
};

export const getClip = async (root: string, reference: string): Promise<Clip> => {
  const clips = await listClips(root);
  const byId = clips.find((clip) => clip.id === reference);
  if (byId !== undefined) return byId;
  const index = Number(reference);
  if (Number.isInteger(index) && index >= 1 && index <= clips.length) {
    const found = clips[index - 1];
    if (found !== undefined) return found;
  }
  throw notFound('Clip', reference);
};

export interface ClipUpdate {
  start?: number;
  end?: number;
  order?: number;
  cameraMode?: CameraMode;
  title?: string | null;
  renderedPath?: string | null;
}

export const updateClip = async (
  root: string,
  reference: string,
  patch: ClipUpdate,
): Promise<Clip> => {
  const clip = await getClip(root, reference);
  const start = patch.start ?? clip.start;
  const end = patch.end ?? clip.end;
  if (end <= start) throw invalidInput('Clip end must be after its start.');

  // Trimming or re-aiming the camera invalidates whatever was already rendered.
  const invalidated = start !== clip.start || end !== clip.end || patch.cameraMode !== undefined;
  const renderedPath =
    patch.renderedPath !== undefined ? patch.renderedPath : invalidated ? null : clip.renderedPath;

  const db = await projectDb(root);
  await execute(
    db,
    `UPDATE clips
       SET start_ts = ?, end_ts = ?, sort_order = ?, camera_mode = ?, title = ?, rendered_path = ?, updated_at = ?
     WHERE id = ?`,
    [
      start,
      end,
      patch.order ?? clip.order,
      patch.cameraMode ?? clip.cameraMode,
      patch.title === undefined ? clip.title : patch.title,
      renderedPath,
      nowIso(),
      clip.id,
    ],
  );

  const row = await get<ClipRow>(db, 'SELECT * FROM clips WHERE id = ?', [clip.id]);
  if (row === undefined) throw notFound('Clip', clip.id);
  return toClip(row);
};

export const removeClip = async (root: string, reference: string): Promise<Clip> => {
  const clip = await getClip(root, reference);
  const db = await projectDb(root);
  await execute(db, 'DELETE FROM clips WHERE id = ?', [clip.id]);
  if (clip.renderedPath !== null && existsSync(clip.renderedPath)) {
    rmSync(clip.renderedPath, { force: true });
  }
  return clip;
};

/** Rewrites `sort_order` to match the given clip ids; unlisted clips keep their tail order. */
export const reorderClips = async (root: string, orderedIds: string[]): Promise<Clip[]> => {
  const clips = await listClips(root);
  const known = new Set(clips.map((clip) => clip.id));
  const unknown = orderedIds.filter((id) => !known.has(id));
  if (unknown.length > 0) throw notFound('Clip', unknown.join(', '));

  const db = await projectDb(root);
  const timestamp = nowIso();
  const sql = 'UPDATE clips SET sort_order = ?, updated_at = ? WHERE id = ?';

  for (const [index, id] of orderedIds.entries()) {
    await execute(db, sql, [index, timestamp, id]);
  }
  // Anything not named keeps a stable relative order after the listed ones.
  const rest = clips.filter((clip) => !orderedIds.includes(clip.id));
  for (const [index, clip] of rest.entries()) {
    await execute(db, sql, [orderedIds.length + index, timestamp, clip.id]);
  }

  return listClips(root);
};

/**
 * Turns every kept moment into a clip. Moments the user has not decided on yet
 * are skipped unless `includeUndecided` is set — silently promoting undecided
 * suggestions would defeat the whole point of the review step.
 */
export const clipsFromMoments = async (
  root: string,
  options: { includeUndecided?: boolean; cameraMode?: CameraMode } = {},
): Promise<Clip[]> => {
  const moments = (await listMoments(root, { limit: 5000 })).filter((moment) =>
    options.includeUndecided === true ? moment.included !== false : moment.included === true,
  );

  /**
   * Derived clips are replaced, not accumulated.
   *
   * Deduplicating on momentId could never work: re-scoring deletes every
   * non-manual moment before regenerating, and clips.moment_id is ON DELETE SET
   * NULL, so the id this used to match on was nulled out from under it. Each
   * run appended another copy — one project reached sixteen clips against a
   * single moment, three of them identical.
   *
   * Clips the user made or kept are marked manual and survive untouched.
   */
  const db = await projectDb(root);
  const removed = await execute(db, 'DELETE FROM clips WHERE manual = 0');
  const replaced = changes(removed);

  const created: Clip[] = [];
  for (const moment of moments) {
    const input: AddClipInput = {
      start: moment.start,
      end: moment.end,
      momentId: moment.id,
      videoId: moment.videoId,
      cameraMode: options.cameraMode ?? 'follow-player',
    };
    if (moment.title !== null) input.title = moment.title;
    created.push(await addClip(root, input));
  }
  if (replaced > 0) {
    // Said out loud: silently deleting clips would be its own bug report.
    process.stderr.write(`clips: replaced ${replaced} generated clip(s)\n`);
  }
  return created;
};
