/**
 * Re-scores an existing project database with the current in-repo scoring code,
 * without touching it. Read-only: it prints what the scorer would say.
 *
 * Bundled and run against production to check a scoring change against the data
 * that motivated it, rather than against synthetic tracks that agree with it.
 *
 *   node scripts/rescore-probe.mjs <project.db> [athleteId]
 */
import { DatabaseSync } from 'node:sqlite';

/*
 * Straight at the built modules, not the package indexes: @reeleel/core's entry
 * pulls in the libsql driver's native binding, which is neither needed here nor
 * portable into a bundle. Run `pnpm -r build` first.
 */
import { getSport } from '../packages/sports/dist/index.js';
import { computeMoments, explainScoring } from '../packages/core/dist/scoring.js';

const [dbPath, athleteOverride] = process.argv.slice(2);
if (dbPath === undefined) throw new Error('usage: rescore-probe.mjs <project.db> [athleteId]');

const db = new DatabaseSync(dbPath, { readOnly: true });
const rows = (sql, ...params) => db.prepare(sql).all(...params);

const video = rows('SELECT id, probe_json FROM source_videos')[0];
const probe = JSON.parse(video.probe_json ?? '{}');

const tracks = rows('SELECT id, class FROM tracks WHERE video_id = ?', video.id).map((track) => ({
  id: track.id,
  className: track.class,
  samples: rows(
    'SELECT ts, x, y, w, h, confidence FROM track_points WHERE track_id = ? ORDER BY frame',
    track.id,
  ),
}));

const athletes = rows('SELECT id, name, focal_track_id, is_focal FROM athletes');
const plugin = getSport(rows("SELECT value FROM meta WHERE key = 'sport'")[0]?.value ?? 'basketball');

for (const athlete of athletes) {
  if (athleteOverride !== undefined && athlete.id !== athleteOverride) continue;
  const assigned = rows('SELECT id FROM tracks WHERE athlete_id = ?', athlete.id).map((r) => r.id);
  const input = {
    durationSeconds: probe.durationSeconds ?? 0,
    frameWidth: probe.video?.width ?? 1920,
    frameHeight: probe.video?.height ?? 1080,
    focalTrackId: athlete.focal_track_id,
    focalTrackIds: assigned.length > 0 ? assigned : undefined,
    tracks,
  };

  const diagnosis = explainScoring(input, plugin);
  const moments = computeMoments(input, plugin);
  console.log(`\n=== ${athlete.name} (${athlete.id}) is_focal=${athlete.is_focal} ===`);
  console.log(`  bound tracks     : ${assigned.length}`);
  console.log(`  on screen        : ${diagnosis.focalSeconds.toFixed(1)}s of ${diagnosis.durationSeconds}s`);
  console.log(`  best window      : ${diagnosis.bestScore.toFixed(3)} at ${diagnosis.bestTs.toFixed(0)}s (threshold ${diagnosis.threshold})`);
  console.log(`  ceiling          : ${diagnosis.ceiling.toFixed(3)} reachable=${diagnosis.reachable}`);
  console.log(`  measurable       : ${diagnosis.measurable.join(', ') || 'none'}`);
  console.log(`  unmeasurable     : ${diagnosis.unmeasurable.join(', ') || 'none'}`);
  console.log(`  moments          : ${moments.length}`);
  for (const moment of moments.slice(0, 12)) {
    console.log(
      `    ${moment.start.toFixed(1)}s–${moment.end.toFixed(1)}s score ${moment.score.toFixed(3)} [${moment.reasons.join(', ')}]`,
    );
  }
}
