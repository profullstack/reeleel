import { listClips } from './clips.js';
import { all, execute, get, projectDb, toNumber } from './db.js';
import { ReelEelError, invalidInput, notFound } from './errors.js';
import { newId, nowIso } from './ids.js';
import { readManifest } from './projects.js';
import { ASPECT_RATIOS } from './types.js';
import type { AspectRatio, Reel } from './types.js';

interface ReelRow {
  id: string;
  project_id: string;
  name: string;
  aspect: AspectRatio;
  title_card: string | null;
  music: string | null;
  keep_original_audio: number;
  created_at: string;
  updated_at: string;
}

export const isAspectRatio = (value: string): value is AspectRatio =>
  (ASPECT_RATIOS as readonly string[]).includes(value);

const clipIdsFor = async (root: string, reelId: string): Promise<string[]> => {
  const db = await projectDb(root);
  const rows = await all<{ clip_id: string }>(
    db,
    'SELECT clip_id FROM reel_clips WHERE reel_id = ? ORDER BY sort_order',
    [reelId],
  );
  return rows.map((row) => row.clip_id);
};

const toReel = async (root: string, row: ReelRow): Promise<Reel> => ({
  id: row.id,
  projectId: row.project_id,
  name: row.name,
  aspect: row.aspect,
  clipIds: await clipIdsFor(root, row.id),
  titleCard: row.title_card,
  music: row.music,
  keepOriginalAudio: toNumber(row.keep_original_audio) === 1,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export interface CreateReelInput {
  name: string;
  aspect?: AspectRatio;
  /** Defaults to every clip in the project, in timeline order. */
  clipIds?: string[];
  titleCard?: string;
  music?: string;
  keepOriginalAudio?: boolean;
}

export const createReel = async (root: string, input: CreateReelInput): Promise<Reel> => {
  const name = input.name.trim();
  if (name.length === 0) throw invalidInput('Reel name cannot be empty.');

  const manifest = readManifest(root);
  const clipIds = input.clipIds ?? (await listClips(root)).map((clip) => clip.id);
  const db = await projectDb(root);
  const id = newId('reel');
  const timestamp = nowIso();

  const existing = await get<{ id: string }>(db, 'SELECT id FROM reels WHERE name = ?', [name]);
  if (existing !== undefined) {
    throw new ReelEelError('CONFLICT', `A reel named "${name}" already exists.`, {
      hint: `Update it instead: reeleel reel update ${name} …`,
    });
  }

  await execute(
    db,
    `INSERT INTO reels (id, project_id, name, aspect, title_card, music, keep_original_audio, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      manifest.id,
      name,
      input.aspect ?? '16:9',
      input.titleCard ?? null,
      input.music ?? null,
      input.keepOriginalAudio === false ? 0 : 1,
      timestamp,
      timestamp,
    ],
  );

  for (const [index, clipId] of clipIds.entries()) {
    await execute(db, 'INSERT INTO reel_clips (reel_id, clip_id, sort_order) VALUES (?, ?, ?)', [
      id,
      clipId,
      index,
    ]);
  }

  const row = await get<ReelRow>(db, 'SELECT * FROM reels WHERE id = ?', [id]);
  if (row === undefined) throw notFound('Reel', id);
  return toReel(root, row);
};

export const listReels = async (root: string): Promise<Reel[]> => {
  const db = await projectDb(root);
  const rows = await all<ReelRow>(db, 'SELECT * FROM reels ORDER BY created_at');
  const reels: Reel[] = [];
  for (const row of rows) reels.push(await toReel(root, row));
  return reels;
};

/** Accepts an id or a name. */
export const getReel = async (root: string, reference: string): Promise<Reel> => {
  const reels = await listReels(root);
  const match = reels.find(
    (reel) => reel.id === reference || reel.name.toLowerCase() === reference.toLowerCase(),
  );
  if (match === undefined) throw notFound('Reel', reference);
  return match;
};

export interface ReelUpdate {
  name?: string;
  aspect?: AspectRatio;
  clipIds?: string[];
  titleCard?: string | null;
  music?: string | null;
  keepOriginalAudio?: boolean;
}

export const updateReel = async (
  root: string,
  reference: string,
  patch: ReelUpdate,
): Promise<Reel> => {
  const reel = await getReel(root, reference);
  if (patch.name !== undefined && patch.name.trim().length === 0) {
    throw invalidInput('Reel name cannot be empty.');
  }

  const db = await projectDb(root);
  if (patch.name !== undefined && patch.name !== reel.name) {
    const clash = await get<{ id: string }>(
      db,
      'SELECT id FROM reels WHERE name = ? AND id != ?',
      [patch.name, reel.id],
    );
    if (clash !== undefined) {
      throw new ReelEelError('CONFLICT', `A reel named "${patch.name}" already exists.`);
    }
  }

  await execute(
    db,
    `UPDATE reels
       SET name = ?, aspect = ?, title_card = ?, music = ?, keep_original_audio = ?, updated_at = ?
     WHERE id = ?`,
    [
      patch.name?.trim() ?? reel.name,
      patch.aspect ?? reel.aspect,
      patch.titleCard === undefined ? reel.titleCard : patch.titleCard,
      patch.music === undefined ? reel.music : patch.music,
      (patch.keepOriginalAudio ?? reel.keepOriginalAudio) ? 1 : 0,
      nowIso(),
      reel.id,
    ],
  );

  if (patch.clipIds !== undefined) {
    await execute(db, 'DELETE FROM reel_clips WHERE reel_id = ?', [reel.id]);
    for (const [index, clipId] of patch.clipIds.entries()) {
      await execute(db, 'INSERT INTO reel_clips (reel_id, clip_id, sort_order) VALUES (?, ?, ?)', [
        reel.id,
        clipId,
        index,
      ]);
    }
  }

  const row = await get<ReelRow>(db, 'SELECT * FROM reels WHERE id = ?', [reel.id]);
  if (row === undefined) throw notFound('Reel', reel.id);
  return toReel(root, row);
};

export const removeReel = async (root: string, reference: string): Promise<Reel> => {
  const reel = await getReel(root, reference);
  const db = await projectDb(root);
  await execute(db, 'DELETE FROM reels WHERE id = ?', [reel.id]);
  return reel;
};

export const addClipsToReel = async (
  root: string,
  reference: string,
  clipIds: string[],
): Promise<Reel> => {
  const reel = await getReel(root, reference);
  const merged = [...reel.clipIds, ...clipIds.filter((id) => !reel.clipIds.includes(id))];
  return updateReel(root, reel.id, { clipIds: merged });
};

export const removeClipsFromReel = async (
  root: string,
  reference: string,
  clipIds: string[],
): Promise<Reel> => {
  const reel = await getReel(root, reference);
  return updateReel(root, reel.id, {
    clipIds: reel.clipIds.filter((id) => !clipIds.includes(id)),
  });
};
