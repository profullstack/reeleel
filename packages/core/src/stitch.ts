import type { TrackSeries } from './scoring.js';

/**
 * Deciding which fragments are the same child — the whole of the judgement, and
 * none of the plumbing.
 *
 * Separated from `appearance.ts` because that module reaches a database, a
 * subprocess and a filesystem, and importing any of it drags in a native driver.
 * The consequence was that the only way to try this against real footage was to
 * *re-implement* it in a probe, and a probe that agrees with a re-implementation
 * proves nothing about what ships. It shipped returning zero matches on the very
 * game a probe had found eight in, and neither the tests nor the probe could
 * have caught it. Everything here is pure, so the real code can be run against
 * real data without the app around it.
 */

export interface AthleteProposal {
  trackId: string;
  /** Colour-signature agreement with the athlete's known tracks, 0..1. */
  score: number;
  startTs: number;
  endTs: number;
  seconds: number;
  samples: number;
  /** The link that justified it, so a person can judge the claim. */
  gapSeconds: number;
  distancePx: number;
}

/**
 * Colour is a veto, never an identifier.
 *
 * Measured on a real game: at a 0.55 colour match, 661 of 1152 candidate tracks
 * qualified — 2,306 seconds of "athlete" in a 300-second video. That is not a
 * tuning failure, it is what a shirt means. Teammates wear the same one, so a
 * colour signature identifies a *team*, and the children it wrongly volunteers
 * are precisely the ones standing next to yours.
 *
 * So the identity claim rests on continuity, and colour only ever rules a link
 * out. The same measurement, three ways: continuity alone recovered 120.3s
 * across 56 tracks (too permissive — it links whoever is nearby); colour alone
 * 2,306s; both together 51.2s across 14 tracks, up from 31.7s across 6, with
 * every link under a second of gap and a few hundred pixels of travel.
 */
export const COLOUR_FLOOR = 0.7;

/** Longest silence a link may be drawn across. */
export const MAX_LINK_SECONDS = 2;

/**
 * How far a child may travel between two fragments, as a fraction of frame
 * width per second, plus a fixed allowance for the tracker's own jitter.
 *
 * At four seconds and this speed the accepted links reached 894 pixels of a
 * 1920-wide frame — most of the way across a court — for eight more seconds of
 * coverage. The gap limit above is where that trade stops being worth taking.
 */
export const LINK_SPEED_FRACTION = 0.31;
export const LINK_SLACK_FRACTION = 0.03;

/** Time span a track occupies. */
export const spanOf = (series: TrackSeries): { start: number; end: number } => {
  const first = series.samples[0];
  const last = series.samples[series.samples.length - 1];
  if (first === undefined || last === undefined) return { start: 0, end: 0 };
  return { start: first.ts, end: last.ts };
};

/**
 * Whether two tracks are ever on screen at the same moment.
 *
 * The hardest constraint available and the cheapest: one child cannot be in two
 * places at once, so a candidate that coexists with a track already known to be
 * the athlete is definitively somebody else — however similar their shirt.
 * Teammates wear the same colour, so without this the strongest false matches
 * would be exactly the children standing next to them.
 */
export const overlapsInTime = (a: TrackSeries, b: TrackSeries): boolean => {
  const first = spanOf(a);
  const second = spanOf(b);
  return first.start <= second.end && second.start <= first.end;
};

/**
 * A handful of boxes spread across a track's life, rather than all of them.
 *
 * A signature wants variety — different moments, poses and lighting — not
 * volume. Sampling every half-second and capping keeps a thirty-second track
 * from drowning out a three-second one in the reference average.
 */
export const sampleBoxes = (
  series: TrackSeries,
  everySeconds = 0.5,
  cap = 12,
): { ts: number; x: number; y: number; w: number; h: number }[] => {
  const picked: { ts: number; x: number; y: number; w: number; h: number }[] = [];
  let nextTs = Number.NEGATIVE_INFINITY;
  for (const sample of series.samples) {
    if (sample.ts < nextTs) continue;
    picked.push({ ts: sample.ts, x: sample.x, y: sample.y, w: sample.w, h: sample.h });
    nextTs = sample.ts + everySeconds;
  }
  if (picked.length <= cap) return picked;

  // Thin evenly rather than truncating, so the tail of a long track is still
  // represented — a child who changes ends of the court is still that child.
  const step = picked.length / cap;
  return Array.from({ length: cap }, (_unused, i) => picked[Math.floor(i * step)]).filter(
    (box): box is { ts: number; x: number; y: number; w: number; h: number } => box !== undefined,
  );
};

/** Weighted mean of several signatures, renormalized. */
export const mergeSignatures = (parts: { signature: number[]; weight: number }[]): number[] => {
  const usable = parts.filter((part) => part.weight > 0 && part.signature.length > 0);
  const first = usable[0];
  if (first === undefined) return [];

  const totals = new Array<number>(first.signature.length).fill(0);
  let weightSum = 0;
  for (const part of usable) {
    weightSum += part.weight;
    for (let i = 0; i < totals.length; i += 1) {
      totals[i] = (totals[i] ?? 0) + (part.signature[i] ?? 0) * part.weight;
    }
  }
  if (weightSum <= 0) return [];
  const scaled = totals.map((value) => value / weightSum);
  const sum = scaled.reduce((a, b) => a + b, 0);
  return sum > 0 ? scaled.map((value) => value / sum) : scaled;
};

const centreOf = (sample: {
  x: number;
  y: number;
  w: number;
  h: number;
}): { x: number; y: number } => ({
  x: sample.x + sample.w / 2,
  y: sample.y + sample.h / 2,
});

export interface Link {
  gapSeconds: number;
  distancePx: number;
}

/**
 * Whether a candidate plausibly continues a known track — picking up where it
 * left off, or leading into where it began.
 *
 * This is the part that actually claims identity, so it is deliberately mean:
 * a short silence, and a distance a child could really have covered in it. Both
 * directions, because a fragment can extend an athlete backwards just as
 * usefully as forwards.
 */
export const linkBetween = (
  known: TrackSeries,
  candidate: TrackSeries,
  frameWidth: number,
  maxSeconds = MAX_LINK_SECONDS,
): Link | null => {
  const knownFirst = known.samples[0];
  const knownLast = known.samples[known.samples.length - 1];
  const otherFirst = candidate.samples[0];
  const otherLast = candidate.samples[candidate.samples.length - 1];
  if (
    knownFirst === undefined ||
    knownLast === undefined ||
    otherFirst === undefined ||
    otherLast === undefined
  ) {
    return null;
  }

  const reach = (gap: number): number =>
    frameWidth * LINK_SPEED_FRACTION * gap + frameWidth * LINK_SLACK_FRACTION;

  const forward = otherFirst.ts - knownLast.ts;
  if (forward > 0 && forward <= maxSeconds) {
    const distance = Math.hypot(
      centreOf(knownLast).x - centreOf(otherFirst).x,
      centreOf(knownLast).y - centreOf(otherFirst).y,
    );
    if (distance <= reach(forward)) return { gapSeconds: forward, distancePx: distance };
  }

  const backward = knownFirst.ts - otherLast.ts;
  if (backward > 0 && backward <= maxSeconds) {
    const distance = Math.hypot(
      centreOf(knownFirst).x - centreOf(otherLast).x,
      centreOf(knownFirst).y - centreOf(otherLast).y,
    );
    if (distance <= reach(backward)) return { gapSeconds: backward, distancePx: distance };
  }

  return null;
};

/** Histogram intersection, mirroring the worker's own comparison. */
export const similarity = (a: number[], b: number[]): number => {
  const length = Math.min(a.length, b.length);
  let shared = 0;
  for (let i = 0; i < length; i += 1) shared += Math.min(a[i] ?? 0, b[i] ?? 0);
  return shared;
};

export interface ChooseOptions {
  reference: TrackSeries[];
  candidates: TrackSeries[];
  signatures: Record<string, number[]>;
  pixels: Record<string, number>;
  frameWidth: number;
  threshold?: number;
  limit?: number;
}

/**
 * Grow the athlete one fragment at a time, re-deriving their appearance after
 * each addition.
 *
 * Iterative rather than a single pass because coverage compounds: the fragment
 * that continues the athlete's *new* last track was not adjacent to anything
 * before it was accepted. Re-averaging the signature as it goes also lets the
 * reference follow a genuine change in lighting down the court, which a
 * signature frozen at the first binding cannot.
 */
export const chooseAthleteTracks = (options: ChooseOptions): AthleteProposal[] => {
  const { reference, signatures, pixels, frameWidth } = options;
  const threshold = options.threshold ?? COLOUR_FLOOR;
  const limit = options.limit ?? 40;

  const chosen = [...reference];
  const accepted: AthleteProposal[] = [];
  const remaining = new Set(options.candidates);

  while (accepted.length < limit) {
    const current = mergeSignatures(
      chosen.map((track) => ({
        signature: signatures[track.id] ?? [],
        weight: pixels[track.id] ?? 0,
      })),
    );
    if (current.length === 0) break;

    let best: { track: TrackSeries; colour: number; link: Link } | null = null;
    for (const track of remaining) {
      // One child, one place at a time — re-checked against everything accepted
      // so far, not only the original binding.
      if (chosen.some((known) => overlapsInTime(known, track))) {
        remaining.delete(track);
        continue;
      }

      let link: Link | null = null;
      for (const known of chosen) {
        const found = linkBetween(known, track, frameWidth);
        if (found !== null && (link === null || found.gapSeconds < link.gapSeconds)) link = found;
      }
      if (link === null) continue;

      const signature = signatures[track.id];
      if (signature === undefined || signature.length === 0) continue;
      const colour = similarity(signature, current);
      if (colour < threshold) continue;

      // Prefer the closest, cleanest link; colour has already done its only job.
      const score = colour - link.distancePx / (frameWidth * 2);
      const bestScore =
        best === null ? -Infinity : best.colour - best.link.distancePx / (frameWidth * 2);
      if (score > bestScore) best = { track, colour, link };
    }

    if (best === null) break;
    remaining.delete(best.track);
    chosen.push(best.track);
    const { start, end } = spanOf(best.track);
    accepted.push({
      trackId: best.track.id,
      score: best.colour,
      startTs: start,
      endTs: end,
      seconds: end - start,
      samples: best.track.samples.length,
      gapSeconds: best.link.gapSeconds,
      distancePx: Math.round(best.link.distancePx),
    });
  }

  return accepted;
};

/**
 * Which tracks are worth comparing at all: people, long enough to measure, and
 * never on screen at the same time as the athlete already is.
 */
export const candidatesFrom = (
  series: TrackSeries[],
  reference: TrackSeries[],
  assigned: ReadonlySet<string>,
  minSeconds: number,
): TrackSeries[] =>
  series.filter((track) => {
    if (assigned.has(track.id)) return false;
    if (track.className !== 'player') return false;
    const { start, end } = spanOf(track);
    if (end - start < minSeconds) return false;
    return !reference.some((known) => overlapsInTime(known, track));
  });
