import { existsSync } from 'node:fs';

import { getAthlete } from './athletes.js';
import { resolveCvWorker } from './analyze.js';
import { ReelEelError } from './errors.js';
import { run } from './ffmpeg.js';
import { loadTrackSeries, tracksForAthlete } from './tracks.js';
import type { TrackSeries } from './scoring.js';
import { listVideos } from './videos.js';

/**
 * Finding the same child in the rest of the game.
 *
 * Re-identification matched on box overlap, which can only ever confirm an
 * athlete where they were already known — it recovers a binding across a
 * re-detection and cannot do anything else. Measured on production, that left
 * an athlete identified for 31.7s of a 300s game across six fragments, all of
 * them inside the one 32-second window the user had originally pointed at.
 * Every signal that follows the athlete was therefore dark for 90% of the
 * footage, and the moments that survived were scene-wide ones that had nothing
 * to do with them.
 *
 * The missing ingredient is appearance. Nothing here decides anything: it
 * ranks, and a human confirms. A wrong answer puts another family's child in
 * your highlight reel, so the design point throughout is that a weak match is
 * dropped rather than guessed.
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
export const mergeSignatures = (
  parts: { signature: number[]; weight: number }[],
): number[] => {
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

const centreOf = (sample: { x: number; y: number; w: number; h: number }): { x: number; y: number } => ({
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

export interface ProposalOptions {
  videoId?: string;
  /** Ignore candidates shorter than this. Default 1.5s. */
  minSeconds?: number;
  /** Minimum agreement to propose at all. Default {@link PROPOSAL_THRESHOLD}. */
  threshold?: number;
  /** Most proposals to return. Default 40. */
  limit?: number;
  signal?: AbortSignal;
}

export interface ProposalResult {
  proposals: AthleteProposal[];
  /** Tracks already assigned to this athlete, which are never proposed again. */
  referenceTrackIds: string[];
  /** How many tracks were compared, so "none found" can be told from "none tried". */
  considered: number;
}

interface WorkerSignatures {
  signatures?: Record<string, number[]>;
  pixels?: Record<string, number>;
  error?: string;
}

/**
 * Ranks the tracks most likely to be this athlete, elsewhere in the video.
 *
 * Nothing is assigned. The caller shows these to a human, because this cannot
 * tell twins apart and should not pretend to.
 */
export const proposeAthleteTracks = async (
  root: string,
  athleteId: string,
  options: ProposalOptions = {},
): Promise<ProposalResult> => {
  const athlete = await getAthlete(root, athleteId);
  const videos = await listVideos(root);
  const video =
    options.videoId === undefined
      ? videos[0]
      : videos.find((candidate) => candidate.id === options.videoId);
  if (video === undefined) {
    throw new ReelEelError('NOT_FOUND', 'This project has no video to search.');
  }

  const series = await loadTrackSeries(root, video.id);
  const assigned = new Set(await tracksForAthlete(root, athlete.id));
  if (athlete.focalTrackId !== null) assigned.add(athlete.focalTrackId);

  const reference = series.filter((track) => assigned.has(track.id));
  if (reference.length === 0) {
    throw new ReelEelError(
      'NOT_FOUND',
      `${athlete.name} is not bound to any track yet, so there is nothing to compare against.`,
      { hint: 'Identify them on one clip first, then search for the rest.' },
    );
  }

  const minSeconds = options.minSeconds ?? 1.5;
  const candidates = series.filter((track) => {
    if (assigned.has(track.id)) return false;
    if (track.className !== 'player') return false;
    const { start, end } = spanOf(track);
    if (end - start < minSeconds) return false;
    // One child, one place at a time.
    return !reference.some((known) => overlapsInTime(known, track));
  });

  if (candidates.length === 0) {
    return { proposals: [], referenceTrackIds: [...assigned], considered: 0 };
  }

  const worker = resolveCvWorker();
  if (worker === null) {
    throw new ReelEelError('WORKER_MISSING', 'The ReelEel CV worker is not installed.', {
      hint: 'Appearance matching reads frames through the worker; install it as for detection.',
    });
  }

  const boxes = [...reference, ...candidates].flatMap((track) =>
    sampleBoxes(track).map((box) => ({ track: track.id, ...box })),
  );

  /**
   * The proxy is the right input here, unlike detection: this measures the
   * colour of a shirt, and 540p carries that perfectly well while decoding in a
   * fraction of the time.
   */
  const input =
    video.proxyPath !== null && existsSync(video.proxyPath) ? video.proxyPath : video.path;

  const result = await run(
    worker.command,
    [...worker.args, 'appearance', '--input', input],
    {
      stdin: JSON.stringify({ boxes }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    },
  );
  if (result.code !== 0) {
    throw new ReelEelError('WORKER_CRASHED', 'The CV worker could not read this video.', {
      hint: result.stderr.trim().split('\n').at(-1) ?? undefined,
    });
  }

  let parsed: WorkerSignatures;
  try {
    parsed = JSON.parse(result.stdout) as WorkerSignatures;
  } catch (cause) {
    throw new ReelEelError('WORKER_CRASHED', 'The CV worker returned output we could not parse.', {
      cause,
    });
  }
  if (parsed.error !== undefined) {
    throw new ReelEelError('WORKER_CRASHED', parsed.error);
  }

  const signatures = parsed.signatures ?? {};
  const pixels = parsed.pixels ?? {};

  const referenceSignature = mergeSignatures(
    reference.map((track) => ({
      signature: signatures[track.id] ?? [],
      weight: pixels[track.id] ?? 0,
    })),
  );
  if (referenceSignature.length === 0) {
    throw new ReelEelError(
      'NOT_FOUND',
      `No frames could be read for ${athlete.name}'s existing tracks, so there is nothing to match.`,
    );
  }

  /**
   * Grow the athlete one fragment at a time, re-deriving their appearance after
   * each addition.
   *
   * Iterative rather than a single pass because coverage compounds: the
   * fragment that continues the athlete's *new* last track was not adjacent to
   * anything before it was accepted. Re-averaging the signature as it goes also
   * lets the reference follow a genuine change in lighting down the court,
   * which a signature frozen at the first binding cannot.
   */
  const threshold = options.threshold ?? COLOUR_FLOOR;
  const frameWidth = video.probe?.video?.width ?? 1920;
  const limit = options.limit ?? 40;

  const chosen = [...reference];
  const accepted: AthleteProposal[] = [];
  const remaining = new Set(candidates);

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

  return {
    proposals: accepted,
    referenceTrackIds: [...assigned],
    considered: candidates.length,
  };
};
