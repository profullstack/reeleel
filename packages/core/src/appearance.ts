import { existsSync } from 'node:fs';

import { getAthlete } from './athletes.js';
import { resolveCvWorker } from './analyze.js';
import { ReelEelError } from './errors.js';
import { run } from './ffmpeg.js';
import {
  candidatesFrom,
  chooseAthleteTracks,
  COLOUR_FLOOR,
  mergeSignatures,
  reachableFrom,
  sampleBoxes,
} from './stitch.js';
import type { AthleteProposal } from './stitch.js';
import { loadTrackSeries, tracksForAthlete } from './tracks.js';
import { listVideos } from './videos.js';

/**
 * Finding the same child in the rest of the game — the plumbing half.
 *
 * Re-identification matched on box overlap, which can only ever confirm an
 * athlete where they were already known. Measured on production, that left an
 * athlete identified for 31.7s of a 300s game across six fragments, all inside
 * the one 32-second window the user had originally pointed at.
 *
 * Every decision lives in `stitch.js`, which touches nothing, so the shipped
 * judgement can be run against real footage without a database or a worker
 * around it. This file only fetches, calls and returns.
 */

export * from './stitch.js';

export interface ProposalOptions {
  /** Search only this video. Omitted means every video in the project. */
  videoId?: string;
  /**
   * Ignore candidates shorter than this. Deliberately far lower than the
   * picker's own floor.
   *
   * A human choosing by eye needs a crop long enough to recognise, so the grid
   * hides anything under 1.5s. Stitching is the opposite case: the short
   * fragments are the connective tissue, and five of the eight links that
   * recovered a real athlete were under 1.5s. Continuity and colour justify
   * them without anyone having to recognise a face in a third of a second.
   */
  minSeconds?: number;
  /** Minimum agreement to accept a link at all. Default {@link COLOUR_FLOOR}. */
  threshold?: number;
  /** Most proposals to return per video. Default 40. */
  limit?: number;
  signal?: AbortSignal;
}

/** A video that could not be searched, and why. */
export interface SkippedVideo {
  videoId: string;
  reason: string;
}

export interface ProposalResult {
  proposals: AthleteProposal[];
  /** Tracks already assigned to this athlete, which are never proposed again. */
  referenceTrackIds: string[];
  /** How many tracks were compared, so "none found" can be told from "none tried". */
  considered: number;
  /** Videos actually stitched — the ones the athlete is bound somewhere in. */
  searchedVideoIds?: string[];
  /** Videos the athlete is in that could not be read. */
  skippedVideos?: SkippedVideo[];
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
  if (videos.length === 0) {
    throw new ReelEelError('NOT_FOUND', 'This project has no video to search.');
  }

  const assigned = new Set(await tracksForAthlete(root, athlete.id));
  if (athlete.focalTrackId !== null) assigned.add(athlete.focalTrackId);

  /**
   * Every video, not the first one.
   *
   * This searched `videos[0]` whenever the caller did not name a video, which
   * is what the picker's "find them in the rest of the game" button does. A
   * project with a second upload — the ordinary case, because the 300s test
   * clip goes in before the hour-long game — searched the clip and reported
   * nothing found, while the game it was asked about was never opened. Track
   * timestamps are per-video, so each one is stitched on its own timeline and
   * the results are concatenated.
   */
  const searchable =
    options.videoId === undefined
      ? videos
      : videos.filter((candidate) => candidate.id === options.videoId);
  if (searchable.length === 0) {
    throw new ReelEelError('NOT_FOUND', 'This project has no video to search.');
  }

  const results: ProposalResult[] = [];
  const searched: string[] = [];
  const skipped: SkippedVideo[] = [];
  for (const video of searchable) {
    /**
     * One unreadable video must not lose the others.
     *
     * A missing proxy on the first upload used to be the whole answer, because
     * the first upload was the only thing searched. Now that every video is
     * opened, a failure on one of them is a partial result, and saying which
     * one failed is more use than failing the search the user asked for.
     */
    try {
      const found = await proposeWithinVideo(root, athlete, video, assigned, options);
      if (found === null) continue;
      searched.push(video.id);
      results.push(found);
    } catch (cause) {
      skipped.push({
        videoId: video.id,
        reason: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }

  if (searched.length === 0 && skipped.length === 0) {
    throw new ReelEelError(
      'NOT_FOUND',
      `${athlete.name} is not bound to any track yet, so there is nothing to compare against.`,
      { hint: 'Identify them on one clip first, then search for the rest.' },
    );
  }
  // Every video the athlete is in failed to open: that is the search failing,
  // not a partial answer, so it is reported as one.
  if (searched.length === 0) {
    const first = skipped[0];
    throw new ReelEelError('WORKER_CRASHED', first?.reason ?? 'Could not search the footage.');
  }

  return {
    proposals: results.flatMap((result) => result.proposals),
    referenceTrackIds: [...assigned],
    considered: results.reduce((sum, result) => sum + result.considered, 0),
    searchedVideoIds: searched,
    skippedVideos: skipped,
  };
};

/**
 * One video's worth of stitching, or `null` when the athlete is not bound
 * anywhere in it.
 *
 * Not being bound in a video is not an error — with several uploads it is the
 * normal state of all but one of them. Only being bound in *none* of them is,
 * and that is the caller's judgement to make.
 */
const proposeWithinVideo = async (
  root: string,
  athlete: Awaited<ReturnType<typeof getAthlete>>,
  video: Awaited<ReturnType<typeof listVideos>>[number],
  assigned: ReadonlySet<string>,
  options: ProposalOptions,
): Promise<ProposalResult | null> => {
  const series = await loadTrackSeries(root, video.id);

  const reference = series.filter((track) => assigned.has(track.id));
  if (reference.length === 0) return null;

  const eligible = candidatesFrom(series, reference, assigned, options.minSeconds ?? 0.25);
  const frameWidth = video.probe?.video?.width ?? 1920;
  /**
   * Continuity first, colour second. Reading a shirt costs a seek and a crop
   * on an hour-long proxy; deciding that no chain of links reaches the track
   * costs arithmetic on two timestamps, and it is the same hard gate either
   * way.
   */
  const candidates = reachableFrom(reference, eligible, frameWidth, options.limit ?? 40);
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

  const result = await run(worker.command, [...worker.args, 'appearance', '--input', input], {
    /**
     * The boxes' pixel space goes with the boxes. Tracks are in source-video
     * coordinates while the file being read is the much smaller proxy, and
     * letting the worker infer the space from the file it opened measured every
     * crop against the wrong scale — which shipped as a confident zero matches.
     */
    stdin: JSON.stringify({
      boxes,
      sourceWidth: frameWidth,
      sourceHeight: video.probe?.video?.height ?? 1080,
    }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
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

  return {
    proposals: chooseAthleteTracks({
      reference,
      candidates,
      signatures,
      pixels,
      frameWidth,
      threshold: options.threshold ?? COLOUR_FLOOR,
      /**
       * The shirt the user actually told us about. Both teams field a 14, and
       * the number is the half of "#14 in white" that no detector can check.
       */
      jerseyColor: athlete.jerseyColor,
      ...(options.limit === undefined ? {} : { limit: options.limit }),
    }),
    referenceTrackIds: [...assigned],
    considered: candidates.length,
  };
};
