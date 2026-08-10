import { describe, expect, it } from 'vitest';

import { sampleAt, stitchFocal } from './scoring.js';
import type { ScoringInput, TrackSeries } from './scoring.js';

/**
 * The tracker splits one child into many tracks, so the picker shows the same
 * athlete as several people and binding one of them follows a fraction of the
 * game. On real footage the longest single track covered 23.9 seconds of a
 * five-minute game; stitching twelve fragments covered 99 and turned zero
 * suggested moments into five.
 */

const series = (id: string, from: number, to: number, confidence = 0.9): TrackSeries => ({
  id,
  className: 'player',
  samples: Array.from({ length: Math.round((to - from) * 2) + 1 }, (_unused, i) => {
    const ts = from + i / 2;
    return { ts, x: 100 + ts * 4, y: 300, w: 40, h: 100, confidence };
  }),
});

const input = (tracks: TrackSeries[], ids: string[]): ScoringInput => ({
  durationSeconds: 300,
  frameWidth: 1920,
  frameHeight: 1080,
  focalTrackId: ids[0] ?? null,
  focalTrackIds: ids,
  tracks,
});

describe('stitching an athlete back together', () => {
  it('spans every fragment, not just the bound one', () => {
    const parts = [series('a', 0, 20), series('b', 100, 130), series('c', 250, 260)];
    const stitched = stitchFocal(input(parts, ['a', 'b', 'c']))!;
    expect(stitched.samples[0]!.ts).toBe(0);
    expect(stitched.samples.at(-1)!.ts).toBe(260);
    // Ordered, because interpolation walks the list in time order.
    const times = stitched.samples.map((s) => s.ts);
    expect([...times].sort((x, y) => x - y)).toEqual(times);
  });

  it('falls back to the single bound track when that is all there is', () => {
    const only = series('a', 0, 20);
    expect(stitchFocal(input([only], ['a']))?.id).toBe('a');
    expect(stitchFocal({ ...input([only], []), focalTrackId: null })).toBeNull();
  });

  it('keeps the more confident observation when fragments overlap', () => {
    // The tracker re-acquires someone it had not yet given up on.
    const weak = { ...series('a', 10, 12, 0.4), id: 'a' };
    const strong = { ...series('b', 10, 12, 0.95), id: 'b' };
    const stitched = stitchFocal(input([weak, strong], ['a', 'b']))!;
    expect(stitched.samples.every((s) => s.confidence === 0.95)).toBe(true);
    // One sample per instant, not two.
    expect(new Set(stitched.samples.map((s) => s.ts)).size).toBe(stitched.samples.length);
  });

  /**
   * The reason gaps must not be bridged: a straight line through a hole puts the
   * athlete on the court while they were on the bench, and scores it.
   */
  it('reports no position inside a gap between fragments', () => {
    const parts = [series('a', 0, 20), series('b', 100, 130)];
    const stitched = stitchFocal(input(parts, ['a', 'b']))!;
    expect(sampleAt(stitched, 60, 2)).toBeNull();
    // But still answers inside a fragment.
    expect(sampleAt(stitched, 10, 2)).not.toBeNull();
    expect(sampleAt(stitched, 110, 2)).not.toBeNull();
  });

  it('ignores ids that do not exist rather than failing the run', () => {
    const parts = [series('a', 0, 20)];
    expect(stitchFocal(input(parts, ['a', 'ghost']))?.samples.length).toBe(41);
    expect(stitchFocal(input(parts, ['ghost']))).toBeNull();
  });
});
