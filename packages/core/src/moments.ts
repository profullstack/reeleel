import { getFocalAthlete } from './athletes.js';
import { all, changes, execute, get, nullableBool, parseJson, projectDb, toNumber } from './db.js';
import { ReelEelError, invalidInput, notFound } from './errors.js';
import { newId, nowIso } from './ids.js';
import { readManifest } from './projects.js';
import { computeMoments } from './scoring.js';
import type { ScoringInput } from './scoring.js';
import { loadTrackSeries } from './tracks.js';
import type { SuggestedMoment } from './types.js';
import { listVideos } from './videos.js';

import { getSport } from '@reeleel/sports';

interface MomentRow {
  id: string;
  project_id: string;
  video_id: string | null;
  athlete_id: string | null;
  start_ts: number;
  end_ts: number;
  score: number;
  reasons_json: string;
  included: number | null;
  favorite: number;
  manual: number;
  title: string | null;
  created_at: string;
  updated_at: string;
}

const toMoment = (row: MomentRow): SuggestedMoment => ({
  id: row.id,
  projectId: row.project_id,
  videoId: row.video_id,
  athleteId: row.athlete_id,
  start: toNumber(row.start_ts),
  end: toNumber(row.end_ts),
  score: toNumber(row.score),
  reasons: parseJson<string[]>(row.reasons_json, []),
  included: nullableBool(row.included),
  favorite: toNumber(row.favorite) === 1,
  manual: toNumber(row.manual) === 1,
  title: row.title,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export interface ListMomentsOptions {
  /** Only moments the user kept (`true`) or rejected (`false`). */
  included?: boolean;
  favorite?: boolean;
  minScore?: number;
  videoId?: string;
  limit?: number;
}

export const listMoments = async (
  root: string,
  options: ListMomentsOptions = {},
): Promise<SuggestedMoment[]> => {
  const db = await projectDb(root);
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  if (options.included !== undefined) {
    clauses.push('included = ?');
    params.push(options.included ? 1 : 0);
  }
  if (options.favorite === true) clauses.push('favorite = 1');
  if (options.minScore !== undefined) {
    clauses.push('score >= ?');
    params.push(options.minScore);
  }
  if (options.videoId !== undefined) {
    clauses.push('video_id = ?');
    params.push(options.videoId);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  params.push(options.limit ?? 500);

  const rows = await all<MomentRow>(
    db,
    `SELECT * FROM suggested_moments ${where} ORDER BY start_ts LIMIT ?`,
    params,
  );
  return rows.map(toMoment);
};

export const getMoment = async (root: string, reference: string): Promise<SuggestedMoment> => {
  const moments = await listMoments(root, { limit: 5000 });
  const byId = moments.find((moment) => moment.id === reference);
  if (byId !== undefined) return byId;

  // 1-based index into the chronological list, which is how they are printed.
  const index = Number(reference);
  if (Number.isInteger(index) && index >= 1 && index <= moments.length) {
    const found = moments[index - 1];
    if (found !== undefined) return found;
  }
  throw notFound('Moment', reference);
};

export interface AddMomentInput {
  start: number;
  end: number;
  videoId?: string | null;
  athleteId?: string | null;
  score?: number;
  reasons?: string[];
  title?: string;
  manual?: boolean;
  included?: boolean | null;
}

export const addMoment = async (
  root: string,
  input: AddMomentInput,
): Promise<SuggestedMoment> => {
  if (!Number.isFinite(input.start) || !Number.isFinite(input.end)) {
    throw invalidInput('Moment start and end must be numbers.');
  }
  if (input.end <= input.start) {
    throw invalidInput('Moment end must be after its start.');
  }

  const manifest = readManifest(root);
  const db = await projectDb(root);
  const id = newId('mom');
  const timestamp = nowIso();

  await execute(
    db,
    `INSERT INTO suggested_moments
       (id, project_id, video_id, athlete_id, start_ts, end_ts, score, reasons_json,
        included, favorite, manual, title, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
    [
      id,
      manifest.id,
      input.videoId ?? null,
      input.athleteId ?? null,
      input.start,
      input.end,
      input.score ?? 1,
      JSON.stringify(input.reasons ?? ['user_marker']),
      input.included === undefined || input.included === null ? null : input.included ? 1 : 0,
      input.manual === false ? 0 : 1,
      input.title ?? null,
      timestamp,
      timestamp,
    ],
  );

  const row = await get<MomentRow>(db, 'SELECT * FROM suggested_moments WHERE id = ?', [id]);
  if (row === undefined) throw notFound('Moment', id);
  return toMoment(row);
};

export interface MomentUpdate {
  start?: number;
  end?: number;
  title?: string | null;
  included?: boolean | null;
  favorite?: boolean;
  score?: number;
}

const includedArg = (patch: MomentUpdate, current: boolean | null): number | null => {
  const next = patch.included === undefined ? current : patch.included;
  return next === null ? null : next ? 1 : 0;
};

export const updateMoment = async (
  root: string,
  reference: string,
  patch: MomentUpdate,
): Promise<SuggestedMoment> => {
  const moment = await getMoment(root, reference);
  const start = patch.start ?? moment.start;
  const end = patch.end ?? moment.end;
  if (end <= start) throw invalidInput('Moment end must be after its start.');

  const db = await projectDb(root);
  await execute(
    db,
    `UPDATE suggested_moments
       SET start_ts = ?, end_ts = ?, title = ?, included = ?, favorite = ?, score = ?, updated_at = ?
     WHERE id = ?`,
    [
      start,
      end,
      patch.title === undefined ? moment.title : patch.title,
      includedArg(patch, moment.included),
      (patch.favorite ?? moment.favorite) ? 1 : 0,
      patch.score ?? moment.score,
      nowIso(),
      moment.id,
    ],
  );

  const row = await get<MomentRow>(db, 'SELECT * FROM suggested_moments WHERE id = ?', [moment.id]);
  if (row === undefined) throw notFound('Moment', moment.id);
  return toMoment(row);
};

export const removeMoment = async (
  root: string,
  reference: string,
): Promise<SuggestedMoment> => {
  const moment = await getMoment(root, reference);
  const db = await projectDb(root);
  await execute(db, 'DELETE FROM suggested_moments WHERE id = ?', [moment.id]);
  return moment;
};

export interface GenerateMomentsOptions {
  videoId?: string;
  /** Analysis granularity in seconds. */
  windowSeconds?: number;
  /** Discard previous non-manual suggestions first. */
  replace?: boolean;
}

export interface GenerateMomentsResult {
  generated: number;
  replaced: number;
  skippedVideos: string[];
}

/**
 * Re-scores existing tracks into suggested moments. This never touches the
 * detector: re-running it is cheap, so the user can retune and re-suggest
 * without paying for analysis again — which is exactly what the PRD's
 * "editing a reel never reruns detection" requirement needs.
 */
export const generateMoments = async (
  root: string,
  options: GenerateMomentsOptions = {},
): Promise<GenerateMomentsResult> => {
  const manifest = readManifest(root);
  const plugin = getSport(manifest.sport);
  if (plugin === null) {
    throw new ReelEelError('SPORT_UNKNOWN', `Project sport "${manifest.sport}" is not installed.`);
  }

  const videos = (await listVideos(root)).filter(
    (video) => options.videoId === undefined || video.id === options.videoId,
  );
  if (videos.length === 0) {
    throw new ReelEelError('NOT_FOUND', 'This project has no imported video to score.', {
      hint: 'Add one with `reeleel import <file>`.',
    });
  }

  const focal = await getFocalAthlete(root);
  let replaced = 0;
  if (options.replace === true) {
    const db = await projectDb(root);
    const result = await execute(db, 'DELETE FROM suggested_moments WHERE manual = 0');
    replaced = changes(result);
  }

  let generated = 0;
  const skippedVideos: string[] = [];

  for (const video of videos) {
    const tracks = await loadTrackSeries(root, video.id);
    if (tracks.length === 0) {
      skippedVideos.push(video.id);
      continue;
    }

    const input: ScoringInput = {
      durationSeconds: video.probe?.durationSeconds ?? 0,
      frameWidth: video.probe?.video?.width ?? 1920,
      frameHeight: video.probe?.video?.height ?? 1080,
      focalTrackId: focal?.focalTrackId ?? null,
      tracks,
    };
    if (options.windowSeconds !== undefined) input.windowSeconds = options.windowSeconds;

    for (const scored of computeMoments(input, plugin)) {
      await addMoment(root, {
        start: scored.start,
        end: scored.end,
        score: scored.score,
        reasons: scored.reasons,
        videoId: video.id,
        athleteId: focal?.id ?? null,
        manual: false,
        included: null,
      });
      generated += 1;
    }
  }

  return { generated, replaced, skippedVideos };
};
