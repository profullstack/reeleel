/**
 * Checks appearance matching against a real project, read-only.
 *
 * Synthetic tests prove a red shirt is not a blue one. They cannot tell you
 * whether two teams of children on an actual gym floor separate at all, which
 * is the only question that matters before this is allowed to suggest anyone.
 *
 *   node --experimental-sqlite scripts/appearance-probe.mjs <project.db> <video> <athleteId>
 */
import { DatabaseSync } from 'node:sqlite';

import { computeSignatures } from '../apps/cv-worker/dist/signatures.js';
import { similarity } from '../apps/cv-worker/dist/appearance.js';

const [dbPath, videoPath, athleteId] = process.argv.slice(2);
if (dbPath === undefined || videoPath === undefined || athleteId === undefined) {
  throw new Error('usage: appearance-probe.mjs <project.db> <video> <athleteId>');
}

const db = new DatabaseSync(dbPath, { readOnly: true });
const rows = (sql, ...params) => db.prepare(sql).all(...params);

const video = rows('SELECT id, probe_json FROM source_videos')[0];
const probe = JSON.parse(video.probe_json ?? '{}');

const tracks = rows('SELECT id, class, athlete_id FROM tracks WHERE video_id = ?', video.id).map(
  (track) => ({
    id: track.id,
    className: track.class,
    athleteId: track.athlete_id,
    samples: rows(
      'SELECT ts, x, y, w, h FROM track_points WHERE track_id = ? ORDER BY frame',
      track.id,
    ),
  }),
);

const span = (t) => ({ start: t.samples[0]?.ts ?? 0, end: t.samples[t.samples.length - 1]?.ts ?? 0 });
const overlaps = (a, b) => span(a).start <= span(b).end && span(b).start <= span(a).end;

const reference = tracks.filter((t) => t.athleteId === athleteId);
const candidates = tracks.filter(
  (t) =>
    t.athleteId !== athleteId &&
    t.className === 'player' &&
    span(t).end - span(t).start >= 1.5 &&
    !reference.some((r) => overlaps(r, t)),
);

console.log(`reference tracks: ${reference.length}, candidates: ${candidates.length}`);

const sample = (t, every = 0.5, cap = 12) => {
  const picked = [];
  let next = -Infinity;
  for (const s of t.samples) {
    if (s.ts < next) continue;
    picked.push(s);
    next = s.ts + every;
  }
  if (picked.length <= cap) return picked;
  const step = picked.length / cap;
  return Array.from({ length: cap }, (_u, i) => picked[Math.floor(i * step)]);
};

const boxes = [...reference, ...candidates].flatMap((t) =>
  sample(t).map((s) => ({ track: t.id, ts: s.ts, x: s.x, y: s.y, w: s.w, h: s.h })),
);
console.log(`boxes to measure: ${boxes.length}`);

const started = Date.now();
const { signatures, pixels, framesRead } = await computeSignatures({
  input: videoPath,
  ffmpegPath: 'ffmpeg',
  sourceWidth: probe.video?.width ?? 1920,
  sourceHeight: probe.video?.height ?? 1080,
  fps: probe.video?.fps ?? 30,
  boxes,
});
console.log(`read ${framesRead} frames in ${Math.round((Date.now() - started) / 1000)}s\n`);

const merge = (parts) => {
  const usable = parts.filter((p) => p.weight > 0 && p.signature?.length);
  if (usable.length === 0) return [];
  const totals = new Array(usable[0].signature.length).fill(0);
  let w = 0;
  for (const p of usable) {
    w += p.weight;
    p.signature.forEach((v, i) => (totals[i] += v * p.weight));
  }
  const scaled = totals.map((v) => v / w);
  const sum = scaled.reduce((a, b) => a + b, 0);
  return sum > 0 ? scaled.map((v) => v / sum) : scaled;
};

const ref = merge(
  reference.map((t) => ({ signature: signatures[t.id], weight: pixels[t.id] ?? 0 })),
);

const scored = candidates
  .map((t) => ({ t, score: signatures[t.id] ? similarity(signatures[t.id], ref) : -1 }))
  .filter((entry) => entry.score >= 0)
  .sort((a, b) => b.score - a.score);

console.log('top 15 by shirt match:');
for (const { t, score } of scored.slice(0, 15)) {
  const s = span(t);
  console.log(`  ${score.toFixed(3)}  ${t.id}  ${s.start.toFixed(0)}s-${s.end.toFixed(0)}s (${(s.end - s.start).toFixed(1)}s)`);
}
console.log('\nbottom 5 by shirt match:');
for (const { t, score } of scored.slice(-5)) {
  const s = span(t);
  console.log(`  ${score.toFixed(3)}  ${t.id}  ${s.start.toFixed(0)}s-${s.end.toFixed(0)}s`);
}

const buckets = [0.8, 0.7, 0.6, 0.55, 0.5, 0.4];
console.log('\nhow many candidates clear each threshold:');
for (const b of buckets) {
  const over = scored.filter((e) => e.score >= b);
  const seconds = over.reduce((sum, e) => sum + (span(e.t).end - span(e.t).start), 0);
  console.log(`  >= ${b}: ${over.length} track(s), ${seconds.toFixed(0)}s of footage`);
}
