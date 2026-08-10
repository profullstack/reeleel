import { describe, expect, it } from 'vitest';

import { candidatesFrom, chooseAthleteTracks } from './stitch.js';
import type { TrackSeries } from './scoring.js';

/**
 * The decision itself, with no video and no database in the way.
 *
 * This module was split out of `appearance.ts` because the only way to try the
 * matching against real footage had been to re-implement it in a probe — and a
 * probe agreeing with a re-implementation is exactly how a version that
 * returned zero matches on real footage passed every check.
 */

const track = (id: string, from: number, to: number, x = 100): TrackSeries => ({
  id,
  className: 'player',
  samples: [
    { ts: from, x, y: 400, w: 40, h: 100, confidence: 0.9 },
    { ts: to, x, y: 400, w: 40, h: 100, confidence: 0.9 },
  ],
});

const RED = [1, 0, 0];
const BLUE = [0, 0, 1];
const FRAME = 1920;

/** Everything measured, so no candidate is dropped for want of pixels. */
const weights = (ids: string[]): Record<string, number> =>
  Object.fromEntries(ids.map((id) => [id, 1000]));

describe('growing an athlete out of fragments', () => {
  it('chains onward, using each new fragment as the next anchor', () => {
    // c only touches b, and b only touches a: a single pass would miss it.
    const reference = [track('a', 10, 20)];
    const candidates = [track('c', 30.5, 40, 140), track('b', 20.5, 30, 120)];
    const accepted = chooseAthleteTracks({
      reference,
      candidates,
      signatures: { a: RED, b: RED, c: RED },
      pixels: weights(['a', 'b', 'c']),
      frameWidth: FRAME,
    });
    expect(accepted.map((p) => p.trackId)).toEqual(['b', 'c']);
  });

  it('refuses a fragment in the wrong shirt however well it lines up', () => {
    const accepted = chooseAthleteTracks({
      reference: [track('a', 10, 20)],
      candidates: [track('other', 20.5, 30, 110)],
      signatures: { a: RED, other: BLUE },
      pixels: weights(['a', 'other']),
      frameWidth: FRAME,
    });
    expect(accepted).toEqual([]);
  });

  it('refuses a matching shirt that does not continue anything', () => {
    // Same colour, but a hundred seconds later: that is a teammate.
    const accepted = chooseAthleteTracks({
      reference: [track('a', 10, 20)],
      candidates: [track('teammate', 120, 130)],
      signatures: { a: RED, teammate: RED },
      pixels: weights(['a', 'teammate']),
      frameWidth: FRAME,
    });
    expect(accepted).toEqual([]);
  });

  it('never takes a fragment that is on screen with the athlete', () => {
    const accepted = chooseAthleteTracks({
      reference: [track('a', 10, 20)],
      candidates: [track('beside', 12, 18, 130)],
      signatures: { a: RED, beside: RED },
      pixels: weights(['a', 'beside']),
      frameWidth: FRAME,
    });
    expect(accepted).toEqual([]);
  });

  it('reports the evidence behind each link, for a human to judge', () => {
    const accepted = chooseAthleteTracks({
      reference: [track('a', 10, 20)],
      candidates: [track('b', 20.5, 30, 160)],
      signatures: { a: RED, b: RED },
      pixels: weights(['a', 'b']),
      frameWidth: FRAME,
    });
    expect(accepted[0]?.gapSeconds).toBeCloseTo(0.5);
    expect(accepted[0]?.distancePx).toBe(60);
    expect(accepted[0]?.score).toBeCloseTo(1);
  });

  it('stops at the limit it was given', () => {
    const candidates = Array.from({ length: 6 }, (_u, i) =>
      track(`c${i}`, 20.5 + i * 10, 30 + i * 10, 100 + i * 20),
    );
    const ids = ['a', ...candidates.map((c) => c.id)];
    const accepted = chooseAthleteTracks({
      reference: [track('a', 10, 20)],
      candidates,
      signatures: Object.fromEntries(ids.map((id) => [id, RED])),
      pixels: weights(ids),
      frameWidth: FRAME,
      limit: 2,
    });
    expect(accepted).toHaveLength(2);
  });

  it('ignores a candidate no frames could be read for', () => {
    const accepted = chooseAthleteTracks({
      reference: [track('a', 10, 20)],
      candidates: [track('b', 20.5, 30, 120)],
      signatures: { a: RED },
      pixels: { a: 1000 },
      frameWidth: FRAME,
    });
    expect(accepted).toEqual([]);
  });
});

describe('which tracks are worth comparing', () => {
  const reference = [track('a', 10, 20)];
  const assigned = new Set(['a']);

  it('keeps the short fragments stitching depends on', () => {
    /**
     * The picker hides anything under 1.5s because a human cannot recognise a
     * face in it. Five of the eight links that recovered a real athlete were
     * shorter than that, so reusing the picker's floor here found nothing.
     */
    const series = [...reference, track('brief', 20.5, 20.8, 120)];
    expect(candidatesFrom(series, reference, assigned, 0.25).map((t) => t.id)).toEqual(['brief']);
    expect(candidatesFrom(series, reference, assigned, 1.5)).toEqual([]);
  });

  it('drops the ball, the rim and the officials', () => {
    const series = [
      ...reference,
      { id: 'ball', className: 'ball', samples: track('x', 21, 25).samples },
      { id: 'ref', className: 'referee', samples: track('x', 21, 25).samples },
      track('player', 21, 25, 120),
    ];
    expect(candidatesFrom(series, reference, assigned, 0.25).map((t) => t.id)).toEqual(['player']);
  });

  it('never offers a track the athlete already has', () => {
    expect(candidatesFrom(reference, reference, assigned, 0.25)).toEqual([]);
  });
});
