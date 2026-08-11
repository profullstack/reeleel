import { describe, expect, it } from 'vitest';

import { getSport } from '@reeleel/sports';

import { buildContext, computeMoments, scoreWindow } from './scoring.js';
import type { ScoringInput, TrackSeries } from './scoring.js';

/**
 * Twenty seconds of cheerleaders at the end of the reel.
 *
 * `scoreWindow` already refuses a window the athlete is not in. But *on screen*
 * is not *involved*, and the gate only asks the former: an athlete standing on
 * the sideline is present, so the two signals that never look at him —
 * `activity_near_goal` and `high_motion` — were free to carry the window on
 * their own. Measured on the arrangement below, which is a cheer routine under
 * the rim while the athlete watches: **0.417** against a 0.35 threshold, with
 * the reasons given as `activity_near_goal, high_motion`.
 *
 * Scene signals still count. They simply cannot originate a moment, only amplify
 * one — a child *in* a scramble is near the ball and moving, and a child
 * watching one contributes nothing for the scene to double.
 */

const plugin = getSport('basketball')!;
const DURATION = 120;

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

/** The athlete, motionless on the sideline for the last half-minute. */
const watching: TrackSeries = {
  id: 'trk_focal',
  className: 'player',
  samples: dense(90, 120, () => ({ x: 120, y: 700 })),
};

/** A cheer routine under the rim: many bodies, much motion, no athlete. */
const cheerleaders: TrackSeries[] = Array.from({ length: 8 }, (_unused, i) => ({
  id: `trk_cheer_${i}`,
  className: 'player',
  samples: dense(90, 120, (ts) => ({
    x: 1400 + Math.sin(ts * 6 + i) * 140,
    y: 300 + Math.cos(ts * 5 + i) * 120,
  })),
}));

/** A quiet first hour, so the median scene speed is genuinely low. */
const idle: TrackSeries[] = Array.from({ length: 4 }, (_unused, i) => ({
  id: `trk_idle_${i}`,
  className: 'player',
  samples: dense(0, 89, (ts) => ({ x: 700 + i * 40 + Math.sin(ts * 0.2) * 4, y: 500 })),
}));

const hoop: TrackSeries = {
  id: 'trk_hoop',
  className: 'hoop',
  samples: dense(0, DURATION, () => ({ x: 1500, y: 200 })),
};

const input: ScoringInput = {
  durationSeconds: DURATION,
  frameWidth: 1920,
  frameHeight: 1080,
  focalTrackId: 'trk_focal',
  focalTrackIds: ['trk_focal'],
  tracks: [watching, ...cheerleaders, ...idle, hoop],
};

describe('a busy court the athlete is only watching', () => {
  const context = buildContext(input, plugin.targetClass);

  it('scores nothing on scene signals alone', () => {
    expect(scoreWindow(context, plugin, 105).score).toBe(0);
  });

  it('names no reasons it cannot stand behind', () => {
    expect(scoreWindow(context, plugin, 105).reasons).toEqual([]);
  });

  it('suggests no moment at all', () => {
    expect(computeMoments(input, plugin)).toEqual([]);
  });
});

describe('a scramble the athlete is actually in', () => {
  /**
   * The same busy court, with the athlete in the middle of it rather than beside
   * it. This must keep scoring: the fix is about who the moment belongs to, not
   * about suppressing crowded footage.
   */
  const playing: TrackSeries = {
    id: 'trk_focal',
    className: 'player',
    samples: dense(90, 120, (ts) => ({ x: 1400 + Math.sin(ts * 4) * 160, y: 320 })),
  };
  const involved: ScoringInput = {
    ...input,
    tracks: [playing, ...cheerleaders, ...idle, hoop],
  };

  it('still scores', () => {
    const context = buildContext(involved, plugin.targetClass);
    expect(scoreWindow(context, plugin, 105).score).toBeGreaterThan(0);
  });

  it('still produces moments', () => {
    expect(computeMoments(involved, plugin).length).toBeGreaterThan(0);
  });
});

describe('with nobody identified', () => {
  /**
   * Untouched, deliberately. Without a focal track there is no one to be absent
   * and no one to be uninvolved, so there is nothing to measure the scene
   * against and the clamp cannot apply. Footage with no athlete identified is
   * still scored on scene motion — that is the pre-existing trade-off, and
   * narrowing it is a different question from whose highlight this is.
   */
  const context = buildContext(
    { ...input, focalTrackId: null, focalTrackIds: [] },
    plugin.targetClass,
  );

  it('still scores the scene, exactly as it did before', () => {
    expect(scoreWindow(context, plugin, 105).score).toBeCloseTo(0.435, 3);
  });

  it('is the identified case, and only that, which the clamp changes', () => {
    const identified = buildContext(input, plugin.targetClass);
    expect(scoreWindow(identified, plugin, 105).score).toBe(0);
    expect(scoreWindow(context, plugin, 105).score).toBeGreaterThan(0);
  });
});
