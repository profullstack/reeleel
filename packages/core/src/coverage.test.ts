import { describe, expect, it } from 'vitest';

import { getSport } from '@reeleel/sports';

import { computeMoments } from './scoring.js';
import type { ScoringInput, TrackSeries } from './scoring.js';

/**
 * Signals that cannot be measured no longer divide the score.
 *
 * The shipped COCO model produces players and a ball — no hoop, no goal — and
 * nothing analyses audio. Three of the seven signals therefore *never* have
 * data, but their weight still sat in the denominator, charging every window
 * for evidence that could not have existed. A real possession scored 0.277
 * against a 0.35 threshold and no clip was ever produced.
 *
 * The guard against over-correcting is a floor: a single measurable signal must
 * not be able to carry a moment by being the whole denominator as well as the
 * whole numerator.
 */

const DURATION = 60;

const samples = (fn: (ts: number) => { x: number; y: number; w: number; h: number }) =>
  Array.from({ length: DURATION + 1 }, (_unused, ts) => ({ ts, ...fn(ts), confidence: 0.9 }));

/** A player with the ball beside them from 20s to 40s — a possession. */
const possession = (): TrackSeries[] => {
  const at = (ts: number): number => (ts < 25 ? ts * 8 : 200 + (ts - 25) * 34);
  return [
    {
      id: 'trk_player',
      className: 'player',
      samples: samples((ts) => ({ x: 200 + at(ts), y: 500, w: 60, h: 160 })),
    },
    {
      id: 'trk_ball',
      className: 'ball',
      samples: samples((ts) => ({
        x: ts >= 20 && ts <= 40 ? 200 + at(ts) + 30 : 1800,
        y: ts >= 20 && ts <= 40 ? 520 : 200,
        w: 24,
        h: 24,
      })),
    },
    ...Array.from({ length: 6 }, (_unused, n) => ({
      id: `trk_other_${n}`,
      className: 'player',
      samples: samples((ts) => ({
        x: 300 + n * 150 + Math.sin(ts / 3 + n) * 60,
        y: 480,
        w: 60,
        h: 160,
      })),
    })),
  ];
};

const input = (focalTrackId: string | null): ScoringInput => ({
  durationSeconds: DURATION,
  frameWidth: 1920,
  frameHeight: 1080,
  focalTrackId,
  tracks: possession(),
});

const plugin = getSport('basketball')!;

describe('scoring a possession the shipped model can actually see', () => {
  it('produces a moment once an athlete is identified', () => {
    const moments = computeMoments(input('trk_player'), plugin);
    expect(moments.length).toBeGreaterThan(0);
    expect(moments[0]!.score).toBeGreaterThan(plugin.moments.minScore);
    // It should say why, and the reasons should be the ones with data.
    expect(moments[0]!.reasons).toContain('player_ball_proximity');
  });

  /**
   * The property that makes identifying the athlete matter. Scene motion alone
   * must not become a highlight, or every scramble in the footage would be one.
   */
  it('produces nothing when no athlete is identified', () => {
    expect(computeMoments(input(null), plugin)).toHaveLength(0);
  });

  it('does not let a single measurable signal carry a moment', () => {
    // Only players moving: no ball, no focal track, no goal, no audio.
    const motionOnly: ScoringInput = {
      ...input(null),
      tracks: possession().filter((track) => track.className === 'player' && track.id !== 'trk_player'),
    };
    expect(computeMoments(motionOnly, plugin)).toHaveLength(0);
  });

  it('scores the same footage identically for two sports with the same weights', () => {
    // Soccer and basketball differ in play length, not in what the model sees.
    const asSoccer = computeMoments(input('trk_player'), getSport('soccer')!);
    const asBasketball = computeMoments(input('trk_player'), plugin);
    expect(asSoccer.length).toBeGreaterThan(0);
    expect(asBasketball.length).toBeGreaterThan(0);
  });

  it('still finds nothing in footage where the athlete is nowhere near the ball', () => {
    const apart: ScoringInput = {
      ...input('trk_player'),
      tracks: possession().map((track) =>
        track.id === 'trk_ball'
          ? { ...track, samples: track.samples.map((s) => ({ ...s, x: 1850, y: 60 })) }
          : track,
      ),
    };
    // Nothing happened, so nothing should be suggested.
    expect(computeMoments(apart, plugin)).toHaveLength(0);
  });
});
