import { describe, expect, it } from 'vitest';

import { getSport } from '@reeleel/sports';

import { capDuration, computeMoments } from './scoring.js';
import type { ScoringInput, TrackSeries } from './scoring.js';

/**
 * "#14 had the ball and it just ended the clip."
 *
 * A window the athlete is not in scores zero, which is the right rule for
 * *starting* a moment and the wrong one for ending it. The run flushes on the
 * first sub-threshold window, so the clip stops the instant the tracker loses
 * the child — and the tracker losing a child is a fact about the tracker, not
 * about the play.
 *
 * Measured on the drive below, which reproduces the report: the athlete is
 * tracked from 20.0s to 30.0s while the ball stays in his hands to 40.0s. The
 * shipped scorer returned 17.0s–31.0s, cutting at the moment he went up.
 */

const plugin = getSport('basketball')!;
const DURATION = 60;

const dense = (
  from: number,
  to: number,
  at: (ts: number) => { x: number; y: number },
): TrackSeries['samples'] => {
  const samples: TrackSeries['samples'] = [];
  for (let ts = from; ts <= to; ts += 1 / 30) {
    samples.push({ ts: Number(ts.toFixed(3)), ...at(ts), w: 70, h: 170, confidence: 0.9 });
  }
  return samples;
};

/** The athlete drives from 20s, and the tracker gives up on him at 30s. */
const focal: TrackSeries = {
  id: 'trk_focal',
  className: 'player',
  samples: dense(20, 30, (ts) => ({ x: 300 + (ts - 20) * 90, y: 600 })),
};

/** The ball he is carrying, which stays in play to 40s. */
const ball: TrackSeries = {
  id: 'trk_ball',
  className: 'ball',
  samples: dense(20, 40, (ts) => ({ x: 310 + (ts - 20) * 90, y: 560 })),
};

const hoop: TrackSeries = {
  id: 'trk_hoop',
  className: 'hoop',
  samples: dense(0, DURATION, () => ({ x: 1500, y: 200 })),
};

const crowd: TrackSeries[] = Array.from({ length: 4 }, (_unused, i) => ({
  id: `trk_crowd_${i}`,
  className: 'player',
  samples: dense(0, DURATION, (ts) => ({
    x: 1400 + Math.sin(ts * 3 + i) * 80,
    y: 300 + Math.cos(ts * 2 + i) * 60,
  })),
}));

const input: ScoringInput = {
  durationSeconds: DURATION,
  frameWidth: 1920,
  frameHeight: 1080,
  focalTrackId: 'trk_focal',
  focalTrackIds: ['trk_focal'],
  tracks: [focal, ball, hoop, ...crowd],
};

describe('following the play past the athlete', () => {
  const moments = computeMoments(input, plugin);

  it('produces the drive as one moment', () => {
    expect(moments).toHaveLength(1);
  });

  it('keeps rolling after the tracker has lost him, while his ball is live', () => {
    const [moment] = moments;
    // The old behaviour ended at 31.0s: the last tracked frame plus post-roll.
    expect(moment?.end).toBeGreaterThan(34);
  });

  it('still respects the sport’s maximum clip length', () => {
    const [moment] = moments;
    expect((moment?.end ?? 0) - (moment?.start ?? 0)).toBeLessThanOrEqual(
      plugin.moments.maxDurationSeconds,
    );
  });

  it('keeps the drive and the shot in one clip', () => {
    /**
     * This used to assert `start > 17` — that the cap had eaten into the
     * run-up — because a 21-second possession could not fit inside a 15-second
     * maximum and something had to go. A possession is not fifteen seconds, and
     * the cap now says so, which leaves nothing to trim: the whole drive from
     * the pre-roll to the ball going dead is one clip.
     */
    const [moment] = moments;
    expect(moment?.start).toBeCloseTo(17, 2);
    expect(moment?.end).toBeGreaterThan(34);
  });

  it('takes the length out of the run-up rather than the finish', () => {
    // Trimming around the peak is right for a long scrappy passage and exactly
    // wrong here, where the last second is the shot we stayed for.
    const capped = capDuration(
      { start: 100, end: 130, score: 0.6, reasons: [], peakTs: 120 },
      plugin.moments.maxDurationSeconds,
      300,
    );
    expect(capped.end).toBe(130);
    expect(capped.start).toBe(130 - plugin.moments.maxDurationSeconds);
  });

  it('keeps following him when the ball detection blinks out', () => {
    /**
     * A basketball is about six pixels across once a 1080p frame becomes a
     * 416x416 tensor, and the detector emitted 4,067 separate ball fragments on
     * the game that prompted this. Ending the tail the instant one of them ends
     * is reading the detector, not the play — he is still standing there with
     * it in his hands.
     */
    const blinking: TrackSeries = {
      id: 'trk_ball',
      className: 'ball',
      samples: dense(20, 31, (ts) => ({ x: 310 + (ts - 20) * 90, y: 560 })),
    };
    const stillThere: TrackSeries = {
      id: 'trk_focal',
      className: 'player',
      samples: dense(20, 38, (ts) => ({ x: 300 + (ts - 20) * 90, y: 600 })),
    };
    const [moment] = computeMoments(
      { ...input, tracks: [stillThere, blinking, hoop, ...crowd] },
      plugin,
    );
    expect(moment?.end ?? 0).toBeGreaterThan(34);
  });

  it('does not follow a ball the athlete never had', () => {
    // The tail is a possession, not a coincidence: a ball at the far end of the
    // court when his track runs out extends nothing.
    const elsewhere: TrackSeries = {
      id: 'trk_ball',
      className: 'ball',
      samples: dense(20, 40, () => ({ x: 1850, y: 120 })),
    };
    const [moment] = computeMoments(
      { ...input, tracks: [focal, elsewhere, hoop, ...crowd] },
      plugin,
    );
    expect(moment === undefined || moment.end <= 33).toBe(true);
  });
});

describe('the maximum clip length, after merging', () => {
  /**
   * `maxDurationSeconds` was applied per run and then discarded: `mergeOverlapping`
   * fuses any two moments whose pre/post roll touches and never re-checked the
   * length, so basketball's 15-second cap produced a 29-second clip out of two
   * legal 15-second ones.
   */
  it('holds a fused moment to the cap', () => {
    const capped = capDuration(
      { start: 100, end: 129, score: 0.5, reasons: [], peakTs: 118 },
      15,
      300,
    );
    expect(capped.end - capped.start).toBeLessThanOrEqual(15);
  });

  it('keeps the peak inside what it kept', () => {
    const capped = capDuration(
      { start: 100, end: 129, score: 0.5, reasons: [], peakTs: 118 },
      15,
      300,
    );
    expect(capped.start).toBeLessThanOrEqual(118);
    expect(capped.end).toBeGreaterThanOrEqual(118);
  });

  it('leaves a moment that already fits exactly alone', () => {
    const moment = { start: 10, end: 20, score: 0.5, reasons: [] };
    expect(capDuration(moment, 15, 300)).toBe(moment);
  });

  it('never extends a moment past the footage', () => {
    const capped = capDuration({ start: 290, end: 320, score: 0.5, reasons: [] }, 15, 300);
    expect(capped.end).toBeLessThanOrEqual(300);
  });
});
