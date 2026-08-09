import { describe, expect, it } from 'vitest';

import { getSport } from '@reeleel/sports';

import {
  computeMoments,
  mergeOverlapping,
  sampleAt,
  scoreWindow,
  buildContext,
  velocityAt,
} from './scoring.js';
import type { ScoringInput, TrackSeries } from './scoring.js';

const soccer = getSport('soccer');
if (soccer === null) throw new Error('soccer plugin missing');

/** A track that walks straight across the frame at a constant speed. */
const linearTrack = (
  id: string,
  className: string,
  from: { x: number; y: number },
  to: { x: number; y: number },
  seconds: number,
  step = 0.5,
): TrackSeries => {
  const samples = [];
  for (let ts = 0; ts <= seconds; ts += step) {
    const t = ts / seconds;
    samples.push({
      ts,
      x: from.x + (to.x - from.x) * t,
      y: from.y + (to.y - from.y) * t,
      w: 40,
      h: 90,
      confidence: 0.9,
    });
  }
  return { id, className, samples };
};

const staticTrack = (id: string, className: string, x: number, y: number, seconds: number): TrackSeries => {
  const samples = [];
  for (let ts = 0; ts <= seconds; ts += 0.5) {
    samples.push({ ts, x, y, w: 60, h: 60, confidence: 0.9 });
  }
  return { id, className, samples };
};

describe('sampleAt', () => {
  const track = linearTrack('t1', 'player', { x: 0, y: 0 }, { x: 100, y: 0 }, 10);

  it('interpolates between samples', () => {
    const point = sampleAt(track, 5);
    expect(point).not.toBeNull();
    // Centre x = box x + w/2, so halfway across is 50 + 20.
    expect(point?.x).toBeCloseTo(70, 1);
  });

  it('returns null outside the track lifetime rather than extrapolating', () => {
    expect(sampleAt(track, -1)).toBeNull();
    expect(sampleAt(track, 11)).toBeNull();
  });

  it('handles an empty track', () => {
    expect(sampleAt({ id: 'x', className: 'ball', samples: [] }, 1)).toBeNull();
  });
});

describe('velocityAt', () => {
  it('measures speed in pixels per second', () => {
    // 100px over 10s = 10px/s.
    const track = linearTrack('t1', 'player', { x: 0, y: 0 }, { x: 100, y: 0 }, 10);
    const velocity = velocityAt(track, 5);
    expect(velocity?.x).toBeCloseTo(10, 1);
    expect(velocity?.y).toBeCloseTo(0, 1);
  });
});

describe('scoreWindow', () => {
  it('fires player_ball_proximity when the ball is on the player', () => {
    const player = staticTrack('p', 'player', 900, 500, 20);
    const ball = staticTrack('b', 'ball', 910, 505, 20);
    const input: ScoringInput = {
      durationSeconds: 20,
      frameWidth: 1920,
      frameHeight: 1080,
      focalTrackId: 'p',
      tracks: [player, ball],
    };
    const score = scoreWindow(buildContext(input), soccer, 10);
    expect(score.reasons).toContain('player_ball_proximity');
    expect(score.score).toBeGreaterThan(0);
  });

  it('stays quiet when the ball is at the far end of the pitch', () => {
    const player = staticTrack('p', 'player', 50, 500, 20);
    const ball = staticTrack('b', 'ball', 1850, 200, 20);
    const input: ScoringInput = {
      durationSeconds: 20,
      frameWidth: 1920,
      frameHeight: 1080,
      focalTrackId: 'p',
      tracks: [player, ball],
    };
    const score = scoreWindow(buildContext(input), soccer, 10);
    expect(score.reasons).not.toContain('player_ball_proximity');
  });

  it('produces no signal at all without a focal track and no goals', () => {
    const input: ScoringInput = {
      durationSeconds: 10,
      frameWidth: 1920,
      frameHeight: 1080,
      focalTrackId: null,
      tracks: [staticTrack('b', 'ball', 100, 100, 10)],
    };
    expect(scoreWindow(buildContext(input), soccer, 5).score).toBe(0);
  });
});

describe('computeMoments', () => {
  it('finds a moment where the ball meets the focal player near goal', () => {
    // Player runs at the goal; the ball travels with them.
    const player = linearTrack('p', 'player', { x: 900, y: 500 }, { x: 1700, y: 500 }, 30);
    const ball = linearTrack('b', 'ball', { x: 920, y: 505 }, { x: 1720, y: 505 }, 30);
    const goal = staticTrack('g', 'goal', 1800, 480, 30);

    const moments = computeMoments(
      {
        durationSeconds: 30,
        frameWidth: 1920,
        frameHeight: 1080,
        focalTrackId: 'p',
        tracks: [player, ball, goal],
      },
      soccer,
    );

    expect(moments.length).toBeGreaterThan(0);
    const first = moments[0];
    expect(first).toBeDefined();
    expect(first?.score).toBeGreaterThanOrEqual(soccer.moments.minScore);
    expect(first?.end).toBeGreaterThan(first?.start ?? 0);
    expect(first?.reasons.length).toBeGreaterThan(0);
  });

  it('returns nothing for an empty or zero-length input', () => {
    const base = { frameWidth: 1920, frameHeight: 1080, focalTrackId: null, tracks: [] };
    expect(computeMoments({ ...base, durationSeconds: 0 }, soccer)).toEqual([]);
    expect(computeMoments({ ...base, durationSeconds: 30 }, soccer)).toEqual([]);
  });

  it('never emits a moment longer than the sport allows', () => {
    const player = staticTrack('p', 'player', 900, 500, 300);
    const ball = staticTrack('b', 'ball', 905, 505, 300);
    const moments = computeMoments(
      {
        durationSeconds: 300,
        frameWidth: 1920,
        frameHeight: 1080,
        focalTrackId: 'p',
        tracks: [player, ball],
      },
      soccer,
    );
    for (const moment of moments) {
      expect(moment.end - moment.start).toBeLessThanOrEqual(soccer.moments.maxDurationSeconds + 0.01);
    }
  });
});

describe('mergeOverlapping', () => {
  it('fuses overlapping moments and keeps the best score', () => {
    const merged = mergeOverlapping([
      { start: 10, end: 20, score: 0.5, reasons: ['a'] },
      { start: 18, end: 30, score: 0.8, reasons: ['b'] },
      { start: 40, end: 50, score: 0.4, reasons: ['c'] },
    ]);
    expect(merged).toHaveLength(2);
    expect(merged[0]).toMatchObject({ start: 10, end: 30, score: 0.8 });
    expect(merged[0]?.reasons).toEqual(['a', 'b']);
  });

  it('leaves disjoint moments alone', () => {
    const input = [
      { start: 0, end: 5, score: 0.9, reasons: [] },
      { start: 10, end: 15, score: 0.7, reasons: [] },
    ];
    expect(mergeOverlapping(input)).toHaveLength(2);
  });
});
