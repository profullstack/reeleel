/**
 * Runs the shipped matching against a real project, read-only.
 *
 * This imports the same `chooseAthleteTracks` and `computeSignatures` the app
 * calls — not a re-implementation. An earlier version of this probe agreed with
 * a re-implementation and the product still returned zero matches, because the
 * bug lived in the plumbing between the two halves and nothing exercised it.
 * `stitch.js` touches no database precisely so this can import it.
 *
 *   node --experimental-sqlite scripts/stitch-probe.mjs <project.db> <video> <athleteId>
 */
import { DatabaseSync } from 'node:sqlite';

import { computeSignatures } from '../apps/cv-worker/dist/signatures.js';
import {
  candidatesFrom,
  chooseAthleteTracks,
  sampleBoxes,
  spanOf,
} from '../packages/core/dist/stitch.js';

const [dbPath, videoPath, athleteId] = process.argv.slice(2);
if (dbPath === undefined || videoPath === undefined || athleteId === undefined) {
  throw new Error('usage: stitch-probe.mjs <project.db> <video> <athleteId>');
}

const db = new DatabaseSync(dbPath, { readOnly: true });
const rows = (sql, ...p) => db.prepare(sql).all(...p);

const video = rows('SELECT id, probe_json FROM source_videos')[0];
const probe = JSON.parse(video.probe_json ?? '{}');
const frameWidth = probe.video?.width ?? 1920;
const frameHeight = probe.video?.height ?? 1080;

const series = rows('SELECT id, class, athlete_id FROM tracks WHERE video_id = ?', video.id).map(
  (t) => ({
    id: t.id,
    className: t.class,
    athleteId: t.athlete_id,
    samples: rows('SELECT ts, x, y, w, h, confidence FROM track_points WHERE track_id = ? ORDER BY frame', t.id),
  }),
);

const assigned = new Set(series.filter((t) => t.athleteId === athleteId).map((t) => t.id));
const reference = series.filter((t) => assigned.has(t.id));
const candidates = candidatesFrom(series, reference, assigned, 0.25);
console.log(`reference: ${reference.length} track(s), candidates: ${candidates.length}`);

const boxes = [...reference, ...candidates].flatMap((t) =>
  sampleBoxes(t).map((b) => ({ track: t.id, ...b })),
);
console.log(`boxes to measure: ${boxes.length}`);

const started = Date.now();
const { signatures, pixels, framesRead } = await computeSignatures({
  input: videoPath,
  ffmpegPath: 'ffmpeg',
  // The boxes' space, which is the source video — not the proxy being read.
  sourceWidth: frameWidth,
  sourceHeight: frameHeight,
  fps: probe.video?.fps ?? 30,
  boxes,
});
console.log(`read ${framesRead} frames in ${Math.round((Date.now() - started) / 1000)}s`);
console.log(`signatures built: ${Object.keys(signatures).length}\n`);

const proposals = chooseAthleteTracks({
  reference,
  candidates,
  signatures,
  pixels,
  frameWidth,
});

const union = (tracks) => {
  const spans = tracks.map(spanOf).sort((a, b) => a.start - b.start);
  let total = 0;
  let cursor = -Infinity;
  for (const s of spans) {
    const from = Math.max(s.start, cursor);
    if (s.end > from) total += s.end - from;
    cursor = Math.max(cursor, s.end);
  }
  return total;
};

for (const p of proposals) {
  console.log(
    `  +${p.startTs.toFixed(1)}-${p.endTs.toFixed(1)}s (${p.seconds.toFixed(1)}s) ` +
      `gap ${p.gapSeconds.toFixed(2)}s dist ${p.distancePx}px colour ${p.score.toFixed(3)}`,
  );
}

const after = [...reference, ...proposals.map((p) => series.find((t) => t.id === p.trackId))].filter(
  Boolean,
);
console.log(`\nbefore: ${reference.length} track(s), ${union(reference).toFixed(1)}s`);
console.log(`after : ${after.length} track(s), ${union(after).toFixed(1)}s`);
