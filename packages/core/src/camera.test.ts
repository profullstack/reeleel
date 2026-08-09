import { describe, expect, it } from 'vitest';

import { aspectValue, computeCropPath, pathJitter, toCropExpression } from './camera.js';
import type { TrackSeries } from './scoring.js';

const track = (id: string, className: string, points: [number, number, number][]): TrackSeries => ({
  id,
  className,
  samples: points.map(([ts, x, y]) => ({ ts, x, y, w: 60, h: 120, confidence: 0.9 })),
});

const SOURCE = { sourceWidth: 3840, sourceHeight: 2160 };

describe('aspectValue', () => {
  it('maps the three shipped ratios', () => {
    expect(aspectValue('16:9')).toBeCloseTo(16 / 9);
    expect(aspectValue('9:16')).toBeCloseTo(9 / 16);
    expect(aspectValue('1:1')).toBe(1);
  });
});

describe('computeCropPath', () => {
  const player = track('p', 'player', [
    [0, 200, 1000],
    [5, 1400, 1000],
    [10, 2600, 1000],
  ]);

  it('follows the athlete across the frame', () => {
    const path = computeCropPath({
      mode: 'follow-player',
      aspect: '16:9',
      ...SOURCE,
      startTs: 0,
      endTs: 10,
      focal: player,
      ball: null,
    });

    expect(path.length).toBeGreaterThan(10);
    const first = path[0];
    const last = path[path.length - 1];
    expect(first).toBeDefined();
    expect(last).toBeDefined();
    // The crop should have travelled right along with the player.
    expect((last?.x ?? 0)).toBeGreaterThan(first?.x ?? 0);
  });

  it('never crops outside the source frame', () => {
    // A player pinned to the far corner would push a naive crop off-canvas.
    const corner = track('p', 'player', [
      [0, 0, 0],
      [10, 3840, 2160],
    ]);
    const path = computeCropPath({
      mode: 'follow-player',
      aspect: '9:16',
      ...SOURCE,
      startTs: 0,
      endTs: 10,
      focal: corner,
      ball: null,
    });

    for (const keyframe of path) {
      expect(keyframe.x).toBeGreaterThanOrEqual(0);
      expect(keyframe.y).toBeGreaterThanOrEqual(0);
      expect(keyframe.x + keyframe.width).toBeLessThanOrEqual(SOURCE.sourceWidth);
      expect(keyframe.y + keyframe.height).toBeLessThanOrEqual(SOURCE.sourceHeight);
    }
  });

  it('keeps the requested aspect ratio', () => {
    const path = computeCropPath({
      mode: 'follow-player',
      aspect: '9:16',
      ...SOURCE,
      startTs: 0,
      endTs: 4,
      focal: player,
      ball: null,
    });
    const first = path[0];
    expect(first).toBeDefined();
    expect((first?.width ?? 0) / (first?.height ?? 1)).toBeCloseTo(9 / 16, 1);
  });

  it('holds still in wide mode', () => {
    const path = computeCropPath({
      mode: 'wide',
      aspect: '16:9',
      ...SOURCE,
      startTs: 0,
      endTs: 10,
      focal: player,
      ball: null,
    });
    expect(pathJitter(path)).toBe(0);
  });

  it('smooths harder than it snaps — jitter stays well under raw motion', () => {
    // A player teleporting back and forth is the worst case for a naive crop.
    const jumpy = track('p', 'player', [
      [0, 200, 1000],
      [1, 3000, 1000],
      [2, 200, 1000],
      [3, 3000, 1000],
      [4, 200, 1000],
    ]);
    const smoothed = computeCropPath({
      mode: 'follow-player',
      aspect: '16:9',
      ...SOURCE,
      startTs: 0,
      endTs: 4,
      focal: jumpy,
      ball: null,
      smoothing: 0.9,
    });
    const snapped = computeCropPath({
      mode: 'follow-player',
      aspect: '16:9',
      ...SOURCE,
      startTs: 0,
      endTs: 4,
      focal: jumpy,
      ball: null,
      smoothing: 0,
    });
    expect(pathJitter(smoothed)).toBeLessThan(pathJitter(snapped));
  });

  it('falls back to the frame centre when there is nothing to follow', () => {
    const path = computeCropPath({
      mode: 'follow-player',
      aspect: '16:9',
      ...SOURCE,
      startTs: 0,
      endTs: 2,
      focal: null,
      ball: null,
    });
    const first = path[0];
    expect(first).toBeDefined();
    expect((first?.x ?? 0) + (first?.width ?? 0) / 2).toBeCloseTo(SOURCE.sourceWidth / 2, -1);
  });
});

describe('toCropExpression', () => {
  it('returns a constant for a single keyframe', () => {
    expect(toCropExpression([{ ts: 0, x: 12, y: 34, width: 100, height: 100 }], 'x')).toBe('12');
  });

  it('returns 0 for an empty path', () => {
    expect(toCropExpression([], 'x')).toBe('0');
  });

  it('builds a piecewise expression over t for a multi-keyframe path', () => {
    const expression = toCropExpression(
      [
        { ts: 0, x: 0, y: 0, width: 10, height: 10 },
        { ts: 1, x: 100, y: 0, width: 10, height: 10 },
      ],
      'x',
    );
    expect(expression).toContain('if(lt(t,1.000)');
    expect(expression).toContain('100.000');
  });
});
