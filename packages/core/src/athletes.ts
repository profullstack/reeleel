import { all, execute, get, projectDb, toNumber } from './db.js';
import { ReelEelError, invalidInput, notFound } from './errors.js';
import { newId, nowIso } from './ids.js';
import { readManifest } from './projects.js';
import type { Athlete } from './types.js';

interface AthleteRow {
  id: string;
  project_id: string;
  name: string | null;
  jersey_number: string | null;
  team: string | null;
  jersey_color: string | null;
  focal_track_id: string | null;
  is_focal: number;
  created_at: string;
  updated_at: string;
}

const toAthlete = (row: AthleteRow): Athlete => ({
  id: row.id,
  projectId: row.project_id,
  name: row.name,
  jerseyNumber: row.jersey_number,
  team: row.team,
  jerseyColor: row.jersey_color,
  focalTrackId: row.focal_track_id,
  isFocal: toNumber(row.is_focal) === 1,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export interface AthleteInput {
  name?: string;
  jerseyNumber?: string;
  team?: string;
  jerseyColor?: string;
  /** Exactly one athlete per project is focal; setting a new one clears the old. */
  focal?: boolean;
}

/**
 * Every field is optional by design — the PRD only requires that the user point
 * at the athlete on screen. Name and number are conveniences, and we
 * deliberately never ask for age, school or location.
 */
export const addAthlete = async (root: string, input: AthleteInput = {}): Promise<Athlete> => {
  const manifest = readManifest(root);
  const db = await projectDb(root);
  const timestamp = nowIso();
  const id = newId('ath');

  const countRow = await get<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM athletes');
  const focal = input.focal ?? toNumber(countRow?.n ?? 0) === 0;

  if (focal) await execute(db, 'UPDATE athletes SET is_focal = 0');

  await execute(
    db,
    `INSERT INTO athletes
       (id, project_id, name, jersey_number, team, jersey_color, is_focal, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      manifest.id,
      input.name ?? null,
      input.jerseyNumber ?? null,
      input.team ?? null,
      input.jerseyColor ?? null,
      focal ? 1 : 0,
      timestamp,
      timestamp,
    ],
  );

  const row = await get<AthleteRow>(db, 'SELECT * FROM athletes WHERE id = ?', [id]);
  if (row === undefined) throw notFound('Athlete', id);
  return toAthlete(row);
};

export const listAthletes = async (root: string): Promise<Athlete[]> => {
  const db = await projectDb(root);
  const rows = await all<AthleteRow>(
    db,
    'SELECT * FROM athletes ORDER BY is_focal DESC, created_at',
  );
  return rows.map(toAthlete);
};

export const getFocalAthlete = async (root: string): Promise<Athlete | null> => {
  const athletes = await listAthletes(root);
  return athletes.find((athlete) => athlete.isFocal) ?? null;
};

/** Accepts an id, a name, or a jersey number. */
export const getAthlete = async (root: string, reference: string): Promise<Athlete> => {
  const athletes = await listAthletes(root);
  const byId = athletes.find((athlete) => athlete.id === reference);
  if (byId !== undefined) return byId;

  const needle = reference.toLowerCase();
  const matches = athletes.filter(
    (athlete) =>
      athlete.name?.toLowerCase() === needle ||
      athlete.jerseyNumber === reference ||
      athlete.name?.toLowerCase().includes(needle) === true,
  );
  const first = matches[0];
  if (matches.length === 1 && first !== undefined) return first;
  if (matches.length > 1) {
    throw new ReelEelError('CONFLICT', `"${reference}" matches ${matches.length} athletes.`, {
      hint: `Use an id: ${matches.map((m) => m.id).join(', ')}`,
    });
  }
  throw notFound('Athlete', reference);
};

export interface AthleteUpdate extends AthleteInput {
  /** Rebind the athlete to a different track after a tracking correction. */
  focalTrackId?: string | null;
}

export const updateAthlete = async (
  root: string,
  reference: string,
  patch: AthleteUpdate,
): Promise<Athlete> => {
  const athlete = await getAthlete(root, reference);
  if (patch.name !== undefined && patch.name.trim().length === 0) {
    throw invalidInput('Athlete name cannot be empty. Omit it instead to leave it unset.');
  }

  const db = await projectDb(root);
  if (patch.focal === true) await execute(db, 'UPDATE athletes SET is_focal = 0');

  await execute(
    db,
    `UPDATE athletes
       SET name = ?, jersey_number = ?, team = ?, jersey_color = ?,
           focal_track_id = ?, is_focal = ?, updated_at = ?
     WHERE id = ?`,
    [
      patch.name ?? athlete.name,
      patch.jerseyNumber ?? athlete.jerseyNumber,
      patch.team ?? athlete.team,
      patch.jerseyColor ?? athlete.jerseyColor,
      patch.focalTrackId === undefined ? athlete.focalTrackId : patch.focalTrackId,
      patch.focal === undefined ? (athlete.isFocal ? 1 : 0) : patch.focal ? 1 : 0,
      nowIso(),
      athlete.id,
    ],
  );

  const row = await get<AthleteRow>(db, 'SELECT * FROM athletes WHERE id = ?', [athlete.id]);
  if (row === undefined) throw notFound('Athlete', athlete.id);
  return toAthlete(row);
};

export const removeAthlete = async (root: string, reference: string): Promise<Athlete> => {
  const athlete = await getAthlete(root, reference);
  const db = await projectDb(root);
  await execute(db, 'DELETE FROM athletes WHERE id = ?', [athlete.id]);

  // Never leave a project with tracks but no focal athlete if one remains.
  if (athlete.isFocal) {
    const next = await get<{ id: string }>(
      db,
      'SELECT id FROM athletes ORDER BY created_at LIMIT 1',
    );
    if (next !== undefined) {
      await execute(db, 'UPDATE athletes SET is_focal = 1, updated_at = ? WHERE id = ?', [
        nowIso(),
        next.id,
      ]);
    }
  }
  return athlete;
};

export const describeAthlete = (athlete: Athlete): string => {
  const parts: string[] = [];
  if (athlete.name !== null) parts.push(athlete.name);
  if (athlete.jerseyNumber !== null) parts.push(`#${athlete.jerseyNumber}`);
  if (athlete.team !== null) parts.push(`(${athlete.team})`);
  return parts.length > 0 ? parts.join(' ') : athlete.id;
};
