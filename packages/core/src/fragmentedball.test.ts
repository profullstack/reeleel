import { describe, expect, it } from 'vitest';

import { getSport } from '@reeleel/sports';

import { ballAt, buildContext, computeMoments } from './scoring.js';
import type { ScoringInput, TrackSeries } from './scoring.js';

/**
 * The ball is not one track.
 *
 * `buildContext` did `tracks.find(t => t.className === 'ball')` — the first ball
 * in the list, and nothing else. A detector that only glimpses the ball emits it
 * as many short fragments (56 of them in the run that prompted this), so the two
 * signals carrying 0.45 of the total weight read a single arbitrary fragment and
 * scored zero for the rest of the game. Measured on this fixture the difference
 * is 0.008 against 0.437, either side of a 0.35 threshold.
 */

const DURATION = 150;
const plugin = getSport('basketball')!;
const NEAR_FROM = 10;
const NEAR_TO = 43;

const at = (ts: number): { x: number; y: number } => ({ x: 120 + ((ts * 9) % 700), y: 300 });

/** The bound athlete, on screen for 33s — the longest track the real run produced. */
const focal: TrackSeries = {
  id: 'trk_focal',
  className: 'player',
  samples: Array.from({ length: 34 }, (_unused, i) => {
    const ts = NEAR_FROM + i;
    return { ts, ...at(ts), w: 40, h: 100, confidence: 0.9 };
  }),
};

/** The ball: genuinely beside the athlete, but detected in ~1.5s bursts. */
const fragments: TrackSeries[] = Array.from({ length: 56 }, (_unused, n) => {
  const start = (n * 2.6) % DURATION;
  const samples = [0, 0.5, 1, 1.5]
    .map((offset) => Math.round((start + offset) * 2) / 2)
    .filter((ts) => ts <= DURATION)
    .map((ts) => {
      const near = ts >= NEAR_FROM && ts <= NEAR_TO;
      const point = at(ts);
      return {
        ts,
        x: near ? point.x + 22 : 880,
        y: near ? point.y + 14 : 70,
        w: 16,
        h: 16,
        confidence: 0.6,
      };
    });
  return { id: `trk_ball_${n}`, className: 'ball', samples };
}).filter((track) => track.samples.length > 1);

const crowd: TrackSeries[] = Array.from({ length: 9 }, (_unused, n) => ({
  id: `trk_other_${n}`,
  className: 'player',
  samples: Array.from({ length: DURATION + 1 }, (_v, ts) => ({
    ts,
    x: 200 + n * 70 + Math.sin(ts / 4 + n) * 50,
    y: 290,
    w: 40,
    h: 100,
    confidence: 0.8,
  })),
}));

const input = (tracks: TrackSeries[]): ScoringInput => ({
  durationSeconds: DURATION,
  frameWidth: 960,
  frameHeight: 540,
  focalTrackId: 'trk_focal',
  tracks,
});

describe('a ball the detector only glimpses', () => {
  it('produces moments when every fragment is considered', () => {
    const moments = computeMoments(input([focal, ...fragments, ...crowd]), plugin);
    expect(moments.length).toBeGreaterThan(0);
    expect(moments[0]!.reasons).toContain('player_ball_proximity');
  });

  it('produces nothing from a single fragment, which is what the old code saw', () => {
    // Same footage, same athlete — only the first ball track is present.
    expect(computeMoments(input([focal, fragments[0]!, ...crowd]), plugin)).toHaveLength(0);
  });

  it('picks the fragment nearest the athlete when several are live at once', () => {
    const decoy: TrackSeries = {
      id: 'trk_ball_decoy',
      className: 'ball',
      // A spectator's bag across the court, live for the same second.
      samples: [20, 20.5, 21].map((ts) => ({ ts, x: 900, y: 60, w: 16, h: 16, confidence: 0.6 })),
    };
    const near: TrackSeries = {
      id: 'trk_ball_near',
      className: 'ball',
      samples: [20, 20.5, 21].map((ts) => {
        const point = at(ts);
        return { ts, x: point.x + 20, y: point.y + 10, w: 16, h: 16, confidence: 0.6 };
      }),
    };
    // Decoy first, so "the first one" would be the wrong answer.
    const context = buildContext(input([focal, decoy, near, ...crowd]), plugin.targetClass);
    expect(ballAt(context, 20)?.track.id).toBe('trk_ball_near');
  });

  it('reports no ball at a moment when no fragment is live', () => {
    const only: TrackSeries = {
      id: 'trk_ball_only',
      className: 'ball',
      samples: [5, 5.5].map((ts) => ({ ts, x: 100, y: 100, w: 16, h: 16, confidence: 0.6 })),
    };
    const sparse = buildContext(input([focal, only, ...crowd]), plugin.targetClass);
    expect(ballAt(sparse, 100)).toBeNull();
    // Gaps are the normal case for a glimpsed ball; the point is that the
    // fragments together cover far more of the game than any one of them.
    expect(ballAt(sparse, 5)).not.toBeNull();
  });

  it('covers more of the game together than the first fragment does alone', () => {
    const every = buildContext(input([focal, ...fragments, ...crowd]), plugin.targetClass);
    const one = buildContext(input([focal, fragments[0]!, ...crowd]), plugin.targetClass);
    const covered = (context: ReturnType<typeof buildContext>): number =>
      Array.from({ length: DURATION * 2 + 1 }, (_unused, i) => i / 2).filter(
        (ts) => ballAt(context, ts) !== null,
      ).length;
    expect(covered(every)).toBeGreaterThan(covered(one) * 10);
  });
});
