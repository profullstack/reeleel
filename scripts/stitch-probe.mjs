/**
 * Does continuity-plus-colour actually recover an athlete, on real footage?
 *
 * Colour alone cannot: a shirt identifies a team, and on this game 661 of 1152
 * candidate tracks cleared a 0.55 colour match — 2306 seconds of "athlete" in a
 * 300-second video. Teammates are the false positives, and they are the ones a
 * parent would most object to.
 *
 * So colour becomes a veto, not an identifier, and the identity claim rests on
 * continuity: a track that begins where and when another ended is the same
 * person. This measures how much of the game that recovers before any of it is
 * allowed near the product.
 *
 *   node --experimental-sqlite scripts/stitch-probe.mjs <project.db> <video> <athleteId>
 */
import { DatabaseSync } from 'node:sqlite';

import { computeSignatures } from '../apps/cv-worker/dist/signatures.js';
import { similarity } from '../apps/cv-worker/dist/appearance.js';

const [dbPath, videoPath, athleteId] = process.argv.slice(2);
const db = new DatabaseSync(dbPath, { readOnly: true });
const rows = (sql, ...p) => db.prepare(sql).all(...p);

const video = rows('SELECT id, probe_json FROM source_videos')[0];
const probe = JSON.parse(video.probe_json ?? '{}');
const W = probe.video?.width ?? 1920;
const H = probe.video?.height ?? 1080;

const tracks = rows('SELECT id, class, athlete_id FROM tracks WHERE video_id = ?', video.id).map((t) => ({
  id: t.id,
  className: t.class,
  athleteId: t.athlete_id,
  samples: rows('SELECT ts, x, y, w, h FROM track_points WHERE track_id = ? ORDER BY frame', t.id),
}));

const first = (t) => t.samples[0];
const last = (t) => t.samples[t.samples.length - 1];
const span = (t) => ({ start: first(t)?.ts ?? 0, end: last(t)?.ts ?? 0 });
const centre = (s) => ({ x: s.x + s.w / 2, y: s.y + s.h / 2 });
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const overlaps = (a, b) => span(a).start <= span(b).end && span(b).start <= span(a).end;

const players = tracks.filter((t) => t.className === 'player' && t.samples.length >= 2);
const reference = tracks.filter((t) => t.athleteId === athleteId);

// One pass for every player track's signature; colour is only ever a veto here.
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
const boxes = players.flatMap((t) => sample(t).map((s) => ({ track: t.id, ...s })));
const { signatures, pixels } = await computeSignatures({
  input: videoPath,
  ffmpegPath: 'ffmpeg',
  sourceWidth: W,
  sourceHeight: H,
  fps: probe.video?.fps ?? 30,
  boxes,
});

const merge = (parts) => {
  const usable = parts.filter((p) => p.weight > 0 && p.signature?.length);
  if (!usable.length) return [];
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

const MAX_GAP = Number(process.env.MAX_GAP ?? 2);
const MAX_SPEED = Number(process.env.MAX_SPEED ?? 600); // source px/s
const COLOUR_FLOOR = Number(process.env.COLOUR_FLOOR ?? 0.7);

const coverage = (set) => {
  const spans = [...set].map((t) => span(t)).sort((a, b) => a.start - b.start);
  let total = 0;
  let cursor = -Infinity;
  for (const s of spans) {
    const from = Math.max(s.start, cursor);
    if (s.end > from) total += s.end - from;
    cursor = Math.max(cursor, s.end);
  }
  return total;
};

const chosen = new Set(reference);
let added = 0;
for (let round = 0; round < 50; round += 1) {
  const ref = merge([...chosen].map((t) => ({ signature: signatures[t.id], weight: pixels[t.id] ?? 0 })));
  let best = null;
  for (const candidate of players) {
    if (chosen.has(candidate)) continue;
    if ([...chosen].some((k) => overlaps(k, candidate))) continue;

    // Continuity against any current end, forwards or backwards.
    let link = null;
    for (const known of chosen) {
      const a = span(known);
      const b = span(candidate);
      const forwardGap = b.start - a.end;
      const backGap = a.start - b.end;
      if (forwardGap > 0 && forwardGap <= MAX_GAP) {
        const d = dist(centre(last(known)), centre(first(candidate)));
        if (d <= MAX_SPEED * forwardGap + 60) link = { gap: forwardGap, d };
      }
      if (backGap > 0 && backGap <= MAX_GAP) {
        const d = dist(centre(first(known)), centre(last(candidate)));
        if (d <= MAX_SPEED * backGap + 60) link = { gap: backGap, d };
      }
    }
    if (link === null) continue;

    const colour = signatures[candidate.id] ? similarity(signatures[candidate.id], ref) : 0;
    if (colour < COLOUR_FLOOR) continue;
    const score = colour - link.d / 4000;
    if (best === null || score > best.score) best = { candidate, score, colour, link };
  }
  if (best === null) break;
  chosen.add(best.candidate);
  added += 1;
  const s = span(best.candidate);
  console.log(
    `  +${s.start.toFixed(1)}-${s.end.toFixed(1)}s (${(s.end - s.start).toFixed(1)}s) gap ${best.link.gap.toFixed(2)}s dist ${best.link.d.toFixed(0)}px colour ${best.colour.toFixed(3)}`,
  );
}

console.log(`\nreference: ${reference.length} track(s), ${coverage(reference).toFixed(1)}s`);
console.log(`stitched : ${chosen.size} track(s), ${coverage(chosen).toFixed(1)}s (added ${added})`);
console.log(`settings : gap<=${MAX_GAP}s speed<=${MAX_SPEED}px/s colour>=${COLOUR_FLOOR}`);
