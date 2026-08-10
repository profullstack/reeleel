import { describe, expect, it } from 'vitest';

import { getSport } from '@reeleel/sports';

import { computeMoments, scoreWindow, buildContext } from './scoring.js';
import type { ScoringInput, TrackSeries } from './scoring.js';

/**
 * Whose highlights are these?
 *
 * `activity_near_goal` and `high_motion` read the whole scene and never look at
 * the athlete. Between them they cleared the threshold on their own, so a
 * production run with the athlete identified from 218s returned seven moments
 * of which five — 49s, 68s, 158s, 175s, 182s — contained no trace of him. They
 * were real scrambles near the rim, and every one of them was somebody else's
 * child.
 */

const DURATION = 300;
const plugin = getSport('basketball')!;

const dense = (from: number, to: number, fn: (ts: number) => { x: number; y: number }) => {
  const out = [];
  for (let ts = from; ts <= to; ts += 1 / 30) {
    out.push({ ts: Number(ts.toFixed(3)), ...fn(ts), w: 60, h: 150, confidence: 0.9 });
  }
  return out;
};

/** The athlete, on screen only in the second half of the game. */
const focal: TrackSeries = {
  id: 'trk_focal',
  className: 'player',
  samples: dense(218, 273, (ts) => ({ x: 400 + Math.sin(ts) * 300, y: 500 })),
};

/** A crowd that is busy near the rim all game long, athlete or no athlete. */
const crowd = Array.from({ length: 6 }, (_unused, i) => ({
  id: `trk_crowd_${i}`,
  className: 'player',
  samples: dense(0, DURATION, (ts) => ({
    x: 1450 + Math.sin(ts * 3 + i) * 90,
    y: 250 + Math.cos(ts * 2 + i) * 80,
  })),
})) as TrackSeries[];

const hoop: TrackSeries = {
  id: 'trk_hoop',
  className: 'hoop',
  samples: dense(0, DURATION, () => ({ x: 1500, y: 200 })),
};

const input = (focalTrackIds: string[]): ScoringInput => ({
  durationSeconds: DURATION,
  frameWidth: 1920,
  frameHeight: 1080,
  focalTrackId: focalTrackIds[0] ?? null,
  focalTrackIds,
  tracks: [focal, ...crowd, hoop],
});

describe('a moment the athlete is not in', () => {
  const bound = buildContext(input(['trk_focal']), plugin.targetClass);

  it('scores nothing while the athlete is off screen, however busy the court', () => {
    // 100s: six players packed under the rim, and no sign of the athlete.
    expect(scoreWindow(bound, plugin, 100).score).toBe(0);
    expect(scoreWindow(bound, plugin, 100).reasons).toEqual([]);
  });

  it('still scores while the athlete is on screen', () => {
    expect(scoreWindow(bound, plugin, 240).score).toBeGreaterThan(0);
  });

  it('suggests nothing outside the athlete’s time on court', () => {
    for (const moment of computeMoments(input(['trk_focal']), plugin)) {
      // Pre/post roll may reach a little past them, but not to another half.
      expect(moment.end).toBeGreaterThan(210);
      expect(moment.start).toBeLessThan(280);
    }
  });

  it('keeps a scramble the athlete is part of', () => {
    // The scene signals are not banned, they just cannot carry a window alone.
    const window = scoreWindow(bound, plugin, 240);
    expect(window.reasons.length).toBeGreaterThan(0);
  });
});

describe('with nobody identified', () => {
  it('leaves the old behaviour alone', () => {
    // Unchanged: without a focal track there is no one to be absent, and the
    // denominator floor is what keeps scene motion from carrying a moment.
    const context = buildContext(input([]), plugin.targetClass);
    expect(scoreWindow(context, plugin, 100).score).toBeLessThan(plugin.moments.minScore);
  });
});
