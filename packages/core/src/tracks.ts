import { all, changes, execute, get, projectDb, toNumber } from './db.js';
import { ReelEelError, notFound } from './errors.js';
import { newId, nowIso } from './ids.js';
import type { TrackSample, TrackSeries } from './scoring.js';

export interface TrackRecord {
  id: string;
  videoId: string | null;
  className: string;
  athleteId: string | null;
  confidence: number;
  startFrame: number | null;
  endFrame: number | null;
  uncertain: boolean;
  pointCount: number;
}

interface TrackRow {
  id: string;
  project_id: string;
  video_id: string | null;
  class: string;
  athlete_id: string | null;
  confidence: number;
  start_frame: number | null;
  end_frame: number | null;
  uncertain: number;
  point_count: number;
}

const toTrack = (row: TrackRow): TrackRecord => ({
  id: row.id,
  videoId: row.video_id,
  className: row.class,
  athleteId: row.athlete_id,
  confidence: toNumber(row.confidence),
  startFrame: row.start_frame === null ? null : toNumber(row.start_frame),
  endFrame: row.end_frame === null ? null : toNumber(row.end_frame),
  uncertain: toNumber(row.uncertain) === 1,
  pointCount: toNumber(row.point_count),
});

const TRACK_WITH_COUNT = `
  SELECT t.*, (SELECT COUNT(*) FROM track_points p WHERE p.track_id = t.id) AS point_count
  FROM tracks t`;

export const listTracks = async (root: string, videoId?: string): Promise<TrackRecord[]> => {
  const db = await projectDb(root);
  const where = videoId === undefined ? '' : 'WHERE t.video_id = ?';
  const params = videoId === undefined ? [] : [videoId];
  const rows = await all<TrackRow>(
    db,
    `${TRACK_WITH_COUNT} ${where} ORDER BY t.class, t.start_frame`,
    params,
  );
  return rows.map(toTrack);
};

export const getTrack = async (root: string, trackId: string): Promise<TrackRecord> => {
  const db = await projectDb(root);
  const row = await get<TrackRow>(db, `${TRACK_WITH_COUNT} WHERE t.id = ?`, [trackId]);
  if (row === undefined) throw notFound('Track', trackId);
  return toTrack(row);
};

/** Track data in the shape the scoring engine expects. */
export const loadTrackSeries = async (root: string, videoId: string): Promise<TrackSeries[]> => {
  const db = await projectDb(root);
  const tracks = await all<{ id: string; class: string }>(
    db,
    'SELECT id, class FROM tracks WHERE video_id = ?',
    [videoId],
  );

  const series: TrackSeries[] = [];
  for (const track of tracks) {
    const samples = await all<TrackSample>(
      db,
      'SELECT ts, x, y, w, h, confidence FROM track_points WHERE track_id = ? ORDER BY frame',
      [track.id],
    );
    series.push({ id: track.id, className: track.class, samples });
  }
  return series;
};

export interface CreateTrackInput {
  videoId: string;
  className: string;
  athleteId?: string | null;
  confidence?: number;
  uncertain?: boolean;
  samples: (TrackSample & { frame: number })[];
}

export const createTrack = async (
  root: string,
  input: CreateTrackInput,
): Promise<TrackRecord> => {
  const db = await projectDb(root);
  const id = newId('trk');
  const frames = input.samples.map((sample) => sample.frame);
  const timestamp = nowIso();

  const projectRow = await get<{ value: string }>(
    db,
    "SELECT value FROM meta WHERE key = 'project_id'",
  );

  // One transaction: a track with no points is worse than no track at all.
  const tx = await db.transaction('write');
  try {
    await tx.execute({
      sql: `INSERT INTO tracks
              (id, project_id, video_id, class, athlete_id, confidence, start_frame, end_frame, uncertain, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        id,
        projectRow?.value ?? '',
        input.videoId,
        input.className,
        input.athleteId ?? null,
        input.confidence ?? 0,
        frames.length > 0 ? Math.min(...frames) : null,
        frames.length > 0 ? Math.max(...frames) : null,
        input.uncertain === true ? 1 : 0,
        timestamp,
        timestamp,
      ],
    });

    for (const sample of input.samples) {
      await tx.execute({
        sql: `INSERT INTO track_points (track_id, frame, ts, x, y, w, h, confidence, occluded, source)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 'model')`,
        args: [id, sample.frame, sample.ts, sample.x, sample.y, sample.w, sample.h, sample.confidence],
      });
    }
    await tx.commit();
  } catch (error) {
    await tx.rollback();
    throw error;
  }

  return getTrack(root, id);
};

export interface TrackUpdate {
  className?: string;
  athleteId?: string | null;
  uncertain?: boolean;
}

export const updateTrack = async (
  root: string,
  trackId: string,
  patch: TrackUpdate,
): Promise<TrackRecord> => {
  const db = await projectDb(root);
  const existing = await get<TrackRow>(db, 'SELECT * FROM tracks WHERE id = ?', [trackId]);
  if (existing === undefined) throw notFound('Track', trackId);

  await execute(
    db,
    'UPDATE tracks SET class = ?, athlete_id = ?, uncertain = ?, updated_at = ? WHERE id = ?',
    [
      patch.className ?? existing.class,
      patch.athleteId === undefined ? existing.athlete_id : patch.athleteId,
      patch.uncertain === undefined ? toNumber(existing.uncertain) : patch.uncertain ? 1 : 0,
      nowIso(),
      trackId,
    ],
  );
  return getTrack(root, trackId);
};

export const removeTrack = async (root: string, trackId: string): Promise<void> => {
  const db = await projectDb(root);
  const existing = await get<{ id: string }>(db, 'SELECT id FROM tracks WHERE id = ?', [trackId]);
  if (existing === undefined) throw notFound('Track', trackId);
  await execute(db, 'DELETE FROM tracks WHERE id = ?', [trackId]);
};

/**
 * Assigns exactly this set of tracks to an athlete, clearing any previous
 * assignment. `tracks.athlete_id` already existed and nothing wrote it; it is
 * the natural home for "these fragments are all the same child", which one
 * `focal_track_id` cannot express.
 */
export const assignTracksToAthlete = async (
  root: string,
  athleteId: string,
  trackIds: string[],
): Promise<number> => {
  const db = await projectDb(root);
  await execute(db, 'UPDATE tracks SET athlete_id = NULL WHERE athlete_id = ?', [athleteId]);
  let assigned = 0;
  for (const trackId of trackIds) {
    const result = await execute(db, 'UPDATE tracks SET athlete_id = ?, updated_at = ? WHERE id = ?', [
      athleteId,
      nowIso(),
      trackId,
    ]);
    assigned += changes(result);
  }
  return assigned;
};

/** Every track assigned to an athlete, in the order they appear on screen. */
export const tracksForAthlete = async (root: string, athleteId: string): Promise<string[]> => {
  const db = await projectDb(root);
  const rows = await all<{ id: string }>(
    db,
    'SELECT id FROM tracks WHERE athlete_id = ? ORDER BY start_frame',
    [athleteId],
  );
  return rows.map((row) => row.id);
};

export interface ClearTracksResult {
  removed: number;
  /** Athletes whose focal binding pointed at a track that no longer exists. */
  unboundAthletes: string[];
}

/**
 * Discards a video's tracks so a re-run replaces them instead of piling on.
 *
 * Detection appended unconditionally, so every re-analysis layered another copy
 * of every track over the last — a project analysed six times scored against six
 * overlapping sets of the same players, including the sets produced by runs that
 * were later found to be broken. It made `others` six times too crowded, gave
 * `find` an arbitrary stale fragment when it wanted "the ball", and grew without
 * bound.
 *
 * `focal_track_id` is a bare column with no foreign key, so it has to be cleared
 * by hand or it dangles at a deleted row and scoring silently loses its anchor.
 * Callers are expected to tell the user their athlete needs re-identifying.
 */
export const clearTracks = async (root: string, videoId: string): Promise<ClearTracksResult> => {
  const db = await projectDb(root);
  const doomed = await all<{ id: string }>(db, 'SELECT id FROM tracks WHERE video_id = ?', [
    videoId,
  ]);
  if (doomed.length === 0) return { removed: 0, unboundAthletes: [] };

  const ids = new Set(doomed.map((row) => row.id));
  const bound = await all<{ id: string; focal_track_id: string | null }>(
    db,
    'SELECT id, focal_track_id FROM athletes WHERE focal_track_id IS NOT NULL',
  );
  const unboundAthletes = bound
    .filter((row) => row.focal_track_id !== null && ids.has(row.focal_track_id))
    .map((row) => row.id);

  await execute(db, 'DELETE FROM tracks WHERE video_id = ?', [videoId]);
  for (const athleteId of unboundAthletes) {
    await execute(db, 'UPDATE athletes SET focal_track_id = NULL WHERE id = ?', [athleteId]);
  }

  return { removed: doomed.length, unboundAthletes };
};

/** What an athlete was following, kept across a re-detection. */
export interface AthleteBinding {
  athleteId: string;
  /** The tracks they were bound to, as geometry rather than as ids. */
  series: TrackSeries[];
}

/**
 * Remembers where each athlete's tracks *were*, before they are deleted.
 *
 * Track ids do not survive re-detection, so replacing a video's tracks used to
 * throw the user's work away: identify your athlete, re-run detection, identify
 * them again — three times in one evening, and once after a ten-minute pass.
 * Positions do survive, because the athlete was in the same place on the same
 * frames whichever run observed them.
 */
export const snapshotAthleteBindings = async (
  root: string,
  videoId: string,
): Promise<AthleteBinding[]> => {
  const db = await projectDb(root);
  const rows = await all<{ id: string; focal_track_id: string | null }>(
    db,
    'SELECT id, focal_track_id FROM athletes',
  );
  const series = await loadTrackSeries(root, videoId);
  const byId = new Map(series.map((track) => [track.id, track]));

  const bindings: AthleteBinding[] = [];
  for (const row of rows) {
    const assigned = await tracksForAthlete(root, row.id);
    const ids = new Set([...assigned, ...(row.focal_track_id === null ? [] : [row.focal_track_id])]);
    const kept = [...ids].map((id) => byId.get(id)).filter((t): t is TrackSeries => t !== undefined);
    if (kept.length > 0) bindings.push({ athleteId: row.id, series: kept });
  }
  return bindings;
};

/** Intersection-over-union of two boxes. */
const boxIou = (a: TrackSample, b: TrackSample): number => {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  const overlap = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  if (overlap <= 0) return 0;
  return overlap / (a.w * a.h + b.w * b.h - overlap);
};

/**
 * How much two tracks look like the same person: mean box overlap across the
 * frames they share, times nothing else. Tracks that never coexist score zero,
 * which is what stops a re-bind from picking a stranger who happened to stand
 * where the athlete used to be an hour of footage later.
 */
export const trackSimilarity = (a: TrackSeries, b: TrackSeries): number => {
  const other = new Map(b.samples.map((sample) => [Math.round(sample.ts * 4), sample]));
  let total = 0;
  let shared = 0;
  for (const sample of a.samples) {
    const match = other.get(Math.round(sample.ts * 4));
    if (match === undefined) continue;
    shared += 1;
    total += boxIou(sample, match);
  }
  return shared === 0 ? 0 : (total / shared) * Math.min(1, shared / 10);
};

/** Below this, a candidate is a different person and the binding is dropped. */
const REBIND_THRESHOLD = 0.3;

/**
 * Re-attaches each athlete to whichever new tracks occupy the same space and
 * time as the ones they were bound to. Returns the athletes that could be
 * restored, so a caller can say plainly which ones still need a human.
 */
export const rebindAthletes = async (
  root: string,
  videoId: string,
  bindings: AthleteBinding[],
): Promise<{ athleteId: string; trackIds: string[] }[]> => {
  if (bindings.length === 0) return [];
  const fresh = await loadTrackSeries(root, videoId);
  if (fresh.length === 0) return [];

  const restored: { athleteId: string; trackIds: string[] }[] = [];
  for (const binding of bindings) {
    /**
     * Every new track that occupies the athlete's old space and time, not the
     * single best one per old fragment.
     *
     * Taking one winner per old fragment made a re-bind incapable of ever
     * *growing* coverage: N fragments in, at most N fragments out, however the
     * new run happened to cut the same child up. A binding to one ten-frame
     * fragment therefore survived re-detection as one ten-frame fragment,
     * twice, while the run underneath it produced 1,415 tracks. Two tracks
     * cannot be the same person at the same instant standing in the same box,
     * so anything clearing the threshold is them.
     */
    const matched = new Set<string>();
    for (const old of binding.series) {
      for (const candidate of fresh) {
        if (candidate.className !== old.className) continue;
        if (trackSimilarity(old, candidate) >= REBIND_THRESHOLD) matched.add(candidate.id);
      }
    }
    if (matched.size === 0) continue;

    // Longest first, so the single `focal_track_id` fallback is the most useful
    // fragment rather than whichever one hashed first.
    const byId = new Map(fresh.map((track) => [track.id, track]));
    const trackIds = [...matched].sort(
      (a, b) => (byId.get(b)?.samples.length ?? 0) - (byId.get(a)?.samples.length ?? 0),
    );
    const primary = trackIds[0];
    if (primary === undefined) continue;
    await assignTracksToAthlete(root, binding.athleteId, trackIds);
    const db = await projectDb(root);
    await execute(db, 'UPDATE athletes SET focal_track_id = ? WHERE id = ?', [
      primary,
      binding.athleteId,
    ]);
    restored.push({ athleteId: binding.athleteId, trackIds });
  }
  return restored;
};

/** Fuses `sourceId` into `targetId` — the annotator's "merge tracks" action. */
export const mergeTracks = async (
  root: string,
  targetId: string,
  sourceId: string,
): Promise<TrackRecord> => {
  if (targetId === sourceId) {
    throw new ReelEelError('INVALID_INPUT', 'Cannot merge a track into itself.');
  }

  const db = await projectDb(root);
  const target = await get<TrackRow>(db, 'SELECT * FROM tracks WHERE id = ?', [targetId]);
  const source = await get<TrackRow>(db, 'SELECT * FROM tracks WHERE id = ?', [sourceId]);
  if (target === undefined) throw notFound('Track', targetId);
  if (source === undefined) throw notFound('Track', sourceId);
  if (target.video_id !== source.video_id) {
    throw new ReelEelError('CONFLICT', 'Tracks from different videos cannot be merged.');
  }

  const tx = await db.transaction('write');
  try {
    // Frames already claimed by the target win — a merge must not create two
    // boxes for the same object on the same frame.
    await tx.execute({
      sql: `DELETE FROM track_points
            WHERE track_id = ? AND frame IN (SELECT frame FROM track_points WHERE track_id = ?)`,
      args: [sourceId, targetId],
    });
    await tx.execute({
      sql: 'UPDATE track_points SET track_id = ? WHERE track_id = ?',
      args: [targetId, sourceId],
    });
    await tx.execute({ sql: 'DELETE FROM tracks WHERE id = ?', args: [sourceId] });
    await tx.execute({
      sql: `UPDATE tracks SET
              start_frame = (SELECT MIN(frame) FROM track_points WHERE track_id = ?),
              end_frame   = (SELECT MAX(frame) FROM track_points WHERE track_id = ?),
              updated_at  = ?
            WHERE id = ?`,
      args: [targetId, targetId, nowIso(), targetId],
    });
    await tx.commit();
  } catch (error) {
    await tx.rollback();
    throw error;
  }

  return getTrack(root, targetId);
};

/** Splits a track at `frame`; points from `frame` onward move to a new track. */
export const splitTrack = async (
  root: string,
  trackId: string,
  frame: number,
): Promise<TrackRecord> => {
  const db = await projectDb(root);
  const existing = await get<TrackRow>(db, 'SELECT * FROM tracks WHERE id = ?', [trackId]);
  if (existing === undefined) throw notFound('Track', trackId);

  const tail = await get<{ n: number }>(
    db,
    'SELECT COUNT(*) AS n FROM track_points WHERE track_id = ? AND frame >= ?',
    [trackId, frame],
  );
  if (toNumber(tail?.n ?? 0) === 0) {
    throw new ReelEelError(
      'INVALID_INPUT',
      `Track ${trackId} has no points at or after frame ${frame}.`,
    );
  }

  const newTrackId = newId('trk');
  const timestamp = nowIso();
  const tx = await db.transaction('write');
  try {
    await tx.execute({
      sql: `INSERT INTO tracks (id, project_id, video_id, class, athlete_id, confidence, uncertain, created_at, updated_at)
            VALUES (?, ?, ?, ?, NULL, ?, 1, ?, ?)`,
      args: [
        newTrackId,
        existing.project_id,
        existing.video_id,
        existing.class,
        toNumber(existing.confidence),
        timestamp,
        timestamp,
      ],
    });
    await tx.execute({
      sql: 'UPDATE track_points SET track_id = ? WHERE track_id = ? AND frame >= ?',
      args: [newTrackId, trackId, frame],
    });
    for (const id of [trackId, newTrackId]) {
      await tx.execute({
        sql: `UPDATE tracks SET
                start_frame = (SELECT MIN(frame) FROM track_points WHERE track_id = ?),
                end_frame   = (SELECT MAX(frame) FROM track_points WHERE track_id = ?),
                updated_at  = ?
              WHERE id = ?`,
        args: [id, id, timestamp, id],
      });
    }
    await tx.commit();
  } catch (error) {
    await tx.rollback();
    throw error;
  }

  return getTrack(root, newTrackId);
};
