import path from 'node:path';

import { projectDir } from './layout.js';
import { loadTrackSeries } from './tracks.js';
import { listVideos } from './videos.js';

/**
 * Choosing which tracked person is *your* athlete.
 *
 * Nothing bound an athlete to a track. `updateAthlete` accepted a
 * `focalTrackId` and no surface ever passed one, so "Follow" set `is_focal`
 * and left `focal_track_id` null — and scoring, which reads the track and not
 * the flag, saw no focal athlete at all. Three of its seven signals need one,
 * carrying most of the weight, so every run was capped at a score of 0.087
 * against a 0.35 threshold no matter what the detector found.
 *
 * A detector cannot know which of twenty children on a court is yours. Somebody
 * has to say so once, which is what this prepares: the tracks worth offering,
 * each with a frame and a box, so the choice can be made by looking rather than
 * by guessing an id.
 */

export interface AthleteCandidate {
  trackId: string;
  videoId: string;
  className: string;
  /** Seconds this track is on screen — the strongest signal of "worth showing". */
  seconds: number;
  samples: number;
  confidence: number;
  /** Timestamp used for the preview frame. */
  previewTs: number;
  /** 1-based thumbnail index containing previewTs. */
  thumbIndex: number;
  /** The box at previewTs, in source pixels. */
  box: { x: number; y: number; w: number; h: number };
  /** Source dimensions, so a client can scale the box onto a thumbnail. */
  sourceWidth: number;
  sourceHeight: number;
}

export interface CandidateOptions {
  videoId?: string;
  /** Ignore anything on screen for less than this. Default 1.5s. */
  minSeconds?: number;
  /** Most candidates to return, longest-lived first. Default 40. */
  limit?: number;
  /**
   * Tracks that must be returned whatever the limit and the floor say.
   *
   * The grid is both the picker and the only view of what is already picked, and
   * those two jobs disagree: showing forty long tracks is right for choosing,
   * and wrong for reviewing a selection the stitcher grew to thirty fragments,
   * most of them under the 1.5s floor. Production had an athlete on 30 tracks
   * with 4 tiles on screen — a count nobody could account for and 26 selections
   * nobody could untick.
   */
  include?: readonly string[];
  /** Thumbnails generated per video; must match generateThumbnails. */
  thumbnailCount?: number;
}

/** Where generateThumbnails puts a video's frames. */
export const thumbnailPath = (root: string, videoId: string, index: number): string =>
  path.join(projectDir(root, 'thumbnails'), videoId, `thumb_${String(index).padStart(5, '0')}.jpg`);

/**
 * Which thumbnail contains a timestamp.
 *
 * generateThumbnails samples at `count / duration` fps, so frame *n* covers
 * `[n * duration / count, (n+1) * duration / count)`. Indices are 1-based
 * because ffmpeg's `%05d` starts at one.
 */
export const thumbnailIndexFor = (ts: number, durationSeconds: number, count: number): number => {
  if (durationSeconds <= 0 || count <= 0) return 1;
  const slot = Math.floor((ts / durationSeconds) * count);
  return Math.min(count, Math.max(1, slot + 1));
};

/**
 * Tracks a person could reasonably point at and say "that one is mine".
 *
 * Ordered by how long each is on screen: a track that survives thirty seconds
 * is both easier to recognise and more useful to follow than one that flickers
 * for half a second, and the tracker produces a great many of the latter.
 */
export const listAthleteCandidates = async (
  root: string,
  options: CandidateOptions = {},
): Promise<AthleteCandidate[]> => {
  const minSeconds = options.minSeconds ?? 1.5;
  const limit = options.limit ?? 40;
  const thumbnailCount = options.thumbnailCount ?? 60;
  const include = new Set(options.include ?? []);

  const videos = (await listVideos(root)).filter(
    (video) => options.videoId === undefined || video.id === options.videoId,
  );

  const candidates: AthleteCandidate[] = [];

  for (const video of videos) {
    const duration = video.probe?.durationSeconds ?? 0;
    const sourceWidth = video.probe?.video?.width ?? 0;
    const sourceHeight = video.probe?.video?.height ?? 0;
    if (duration <= 0 || sourceWidth <= 0 || sourceHeight <= 0) continue;

    for (const track of await loadTrackSeries(root, video.id)) {
      // Only people can be an athlete; the ball is not a candidate.
      if (track.className !== 'player' && track.className !== 'goalkeeper') continue;
      if (track.samples.length < 2) continue;

      const first = track.samples[0];
      const last = track.samples[track.samples.length - 1];
      if (first === undefined || last === undefined) continue;

      const seconds = last.ts - first.ts;
      if (seconds < minSeconds && !include.has(track.id)) continue;

      // The middle of the track is the most likely to show the athlete clearly:
      // the ends are where a tracker acquires and loses its target.
      const midpoint = first.ts + seconds / 2;
      const sample =
        track.samples.reduce(
          (best, current) =>
            Math.abs(current.ts - midpoint) < Math.abs(best.ts - midpoint) ? current : best,
          first,
        ) ?? first;

      const confidence =
        track.samples.reduce((sum, entry) => sum + entry.confidence, 0) / track.samples.length;

      candidates.push({
        trackId: track.id,
        videoId: video.id,
        className: track.className,
        seconds: Number(seconds.toFixed(1)),
        samples: track.samples.length,
        confidence: Number(confidence.toFixed(3)),
        previewTs: Number(sample.ts.toFixed(2)),
        thumbIndex: thumbnailIndexFor(sample.ts, duration, thumbnailCount),
        box: { x: sample.x, y: sample.y, w: sample.w, h: sample.h },
        sourceWidth,
        sourceHeight,
      });
    }
  }

  /**
   * The limit trims the choosing, never the chosen. A track the caller asked
   * for is on screen even if a hundred longer ones exist, because the only way
   * to unpick it is to see it.
   */
  const ordered = candidates.sort((a, b) => b.seconds - a.seconds);
  const required = ordered.filter((candidate) => include.has(candidate.trackId));
  // The limit is how many *unpicked* tracks are worth browsing, so a long
  // selection does not eat the choice it is being compared against.
  const rest = ordered.filter((candidate) => !include.has(candidate.trackId)).slice(0, limit);
  return [...required, ...rest].sort((a, b) => b.seconds - a.seconds);
};
