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

/**
 * Which bins of the worker's histogram a named shirt colour occupies.
 *
 * The layout is the worker's own: twelve hues by two saturations (0..23, thirty
 * degrees each), then four lightness bins for everything too washed out or too
 * dark to carry a hue (24 darkest .. 27 brightest). White and black are
 * therefore not hues at all but opposite ends of the grey ramp, which is exactly
 * why they separate so well — measured on representative torso crops, a white
 * shirt against a black one intersects at 0.28, against a floor of 0.70.
 *
 * `jersey_color` has been on the athlete row since the first migration, and
 * until now nothing but a label has ever read it. The matcher could be told a
 * name and a number, and a number is the one attribute a detector cannot match
 * on — so "#14 in white" and "#14 in black" were the same question, and the
 * answer was whichever child the continuity gate reached first.
 */
export const JERSEY_BINS: Record<string, number[]> = {
  white: [27, 26],
  black: [24, 25],
  grey: [25, 26],
  gray: [25, 26],
  silver: [25, 26],
  red: [0, 1, 22, 23],
  maroon: [0, 1, 22, 23],
  orange: [2, 3],
  yellow: [4, 5],
  gold: [4, 5],
  green: [6, 7, 8, 9],
  teal: [10, 11, 12, 13],
  cyan: [10, 11, 12, 13],
  blue: [14, 15, 16, 17],
  navy: [14, 15, 16, 17],
  royal: [14, 15, 16, 17],
  purple: [18, 19],
  violet: [18, 19],
  pink: [20, 21],
  magenta: [20, 21],
};

/**
 * How much of a torso must be the declared colour before a track can be this
 * athlete at all.
 *
 * Deliberately low. A crop catches shorts, skin, floor and whoever is standing
 * behind, so even a correct shirt rarely holds much more than two thirds of the
 * histogram — while the *wrong team* contributes almost none of it. The bar only
 * has to sit inside that gap, and sitting near the bottom of it keeps a shirt in
 * shadow from disowning its own child.
 */
export const JERSEY_FLOOR = 0.2;

/**
 * How much of this signature is the named colour, or null when there is nothing
 * to judge by — no colour recorded, or a word we have no bins for.
 *
 * Null rather than zero matters: an unrecognised colour has to leave matching
 * exactly as permissive as it was, never silently reject every candidate in the
 * game because somebody typed "sky blue".
 */
export const jerseyMass = (
  signature: number[],
  colour: string | null | undefined,
): number | null => {
  if (colour === null || colour === undefined) return null;
  const bins = JERSEY_BINS[colour.trim().toLowerCase()];
  if (bins === undefined) return null;
  return bins.reduce((sum, bin) => sum + (signature[bin] ?? 0), 0);
};

/**
 * Longest silence a link may be drawn across.
 *
 * Two seconds was measured against a detection run that produced 1,415 tracks.
 * A later run of the same 300s game produced 1,648, and at that fragmentation
 * two seconds stopped reaching: of 885 candidates, **4** could link to the
 * athlete at all, and none of those four also cleared {@link COLOUR_FLOOR}, so
 * the matcher considered 885 tracks and proposed nothing. The athlete stayed on
 * the 10.3s the user had pointed at by hand, and 10.3s of focal track in a
 * 300-second game yields exactly one suggested moment.
 *
 * Six seconds, with the reach cap below, restores it: 45.4s of coverage and 5
 * moments, at a *stricter* worst-case travel than two seconds allowed.
 */
export const MAX_LINK_SECONDS = 6;

/**
 * How far a child may travel between two fragments, as a fraction of frame
 * width per second, plus a fixed allowance for the tracker's own jitter.
 *
 * At four seconds and this speed the accepted links reached 894 pixels of a
 * 1920-wide frame — most of the way across a court — for eight more seconds of
 * coverage.
 */
export const LINK_SPEED_FRACTION = 0.31;
export const LINK_SLACK_FRACTION = 0.03;

/**
 * Ceiling on that reach, as a fraction of frame width.
 *
 * The formula above grows without bound, and at this speed it passes a whole
 * frame width by 3.1 seconds — so raising the gap limit alone does not loosen
 * the distance gate, it *removes* it. Measured: at a 4s gap and no cap, accepted
 * links reached 1,676px of a 1920px frame, which is the far side of the court.
 *
 * That matters more than it looks. Colour identifies a team, not a child (see
 * {@link COLOUR_FLOOR}), so continuity is the only thing standing between an
 * athlete and the teammate beside them — and a link drawn clear across the
 * court is not continuity, it is a coin toss. Capped at a quarter of the frame,
 * the longest accepted link on production footage is 419px.
 */
export const LINK_REACH_CAP = 0.25;

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
    frameWidth * Math.min(LINK_SPEED_FRACTION * gap + LINK_SLACK_FRACTION, LINK_REACH_CAP);

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
  /**
   * The shirt the athlete was said to be wearing. Absent or unrecognised leaves
   * matching exactly as it was.
   */
  jerseyColor?: string | null;
  /** Minimum share of the torso that must be that colour. Default {@link JERSEY_FLOOR}. */
  jerseyFloor?: number;
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
  const jerseyFloor = options.jerseyFloor ?? JERSEY_FLOOR;
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

      /**
       * The declared shirt, checked against the shirt itself rather than against
       * the running average.
       *
       * `current` is re-derived after every acceptance so it can follow the
       * athlete's own lighting down the court — which also means it can be
       * walked, one admissible step at a time, toward a shirt the athlete never
       * wore. An absolute bar cannot be walked: the other team fails it at every
       * step, however good the continuity that led there.
       */
      const declared = jerseyMass(signature, options.jerseyColor);
      if (declared !== null && declared < jerseyFloor) continue;

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
