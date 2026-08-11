import { describe, expect, it } from 'vitest';

import {
  COLOUR_FLOOR,
  MAX_LINK_SECONDS,
  linkBetween,
  mergeSignatures,
  overlapsInTime,
  sampleBoxes,
  similarity,
  spanOf,
} from './appearance.js';
import type { TrackSeries } from './scoring.js';

/**
 * Appearance matching exists because box overlap can only confirm an athlete
 * where they were already known — on production it left a child identified for
 * 31.7s of a 300s game. The risk it introduces is the mirror image: a confident
 * wrong match puts another family's child in the reel. These tests are mostly
 * about the guards, not the matching.
 */

const track = (id: string, from: number, to: number, step = 0.25): TrackSeries => ({
  id,
  className: 'player',
  samples: Array.from({ length: Math.round((to - from) / step) + 1 }, (_unused, i) => ({
    ts: Number((from + i * step).toFixed(3)),
    x: 100 + i,
    y: 200,
    w: 40,
    h: 100,
    confidence: 0.9,
  })),
});

describe('a track’s span', () => {
  it('reads first and last sample', () => {
    expect(spanOf(track('a', 10, 20))).toEqual({ start: 10, end: 20 });
  });

  it('does not throw on an empty track', () => {
    expect(spanOf({ id: 'empty', className: 'player', samples: [] })).toEqual({ start: 0, end: 0 });
  });
});

describe('one child cannot be in two places at once', () => {
  it('rejects a candidate that shares any moment with a known track', () => {
    // The most dangerous false match there is: a teammate in the same kit,
    // standing next to them. Colour cannot separate those; time can.
    expect(overlapsInTime(track('known', 10, 20), track('teammate', 15, 25))).toBe(true);
    expect(overlapsInTime(track('known', 10, 20), track('teammate', 19.9, 40))).toBe(true);
  });

  it('allows a candidate from a different part of the game', () => {
    expect(overlapsInTime(track('known', 10, 20), track('later', 20.5, 40))).toBe(false);
    expect(overlapsInTime(track('known', 100, 120), track('earlier', 10, 40))).toBe(false);
  });

  it('treats touching spans as overlapping', () => {
    expect(overlapsInTime(track('a', 10, 20), track('b', 20, 30))).toBe(true);
  });
});

describe('choosing which boxes to look at', () => {
  it('spreads samples across the track rather than taking consecutive frames', () => {
    const boxes = sampleBoxes(track('a', 0, 10, 0.05), 0.5, 12);
    expect(boxes.length).toBeLessThanOrEqual(12);
    const gaps = boxes.slice(1).map((box, i) => box.ts - (boxes[i]?.ts ?? 0));
    for (const gap of gaps) expect(gap).toBeGreaterThan(0.3);
  });

  it('caps a long track without dropping its tail', () => {
    const boxes = sampleBoxes(track('a', 0, 120, 0.25), 0.5, 10);
    expect(boxes).toHaveLength(10);
    // A child who crosses to the other end of the court is still that child.
    expect(boxes[boxes.length - 1]?.ts).toBeGreaterThan(90);
  });

  it('keeps a short track whole', () => {
    const boxes = sampleBoxes(track('a', 0, 2, 0.25), 0.5, 12);
    expect(boxes).toHaveLength(5);
  });

  it('returns nothing for an empty track instead of throwing', () => {
    expect(sampleBoxes({ id: 'e', className: 'player', samples: [] })).toEqual([]);
  });
});

describe('building the reference signature', () => {
  it('weights by evidence, so a glimpse cannot outvote a long look', () => {
    const merged = mergeSignatures([
      { signature: [1, 0, 0], weight: 1000 },
      { signature: [0, 1, 0], weight: 1 },
    ]);
    expect(merged[0]).toBeGreaterThan(0.99);
  });

  it('sums to one, so it is comparable to any candidate', () => {
    const merged = mergeSignatures([
      { signature: [0.5, 0.5, 0], weight: 3 },
      { signature: [0, 0.25, 0.75], weight: 7 },
    ]);
    expect(merged.reduce((a, b) => a + b, 0)).toBeCloseTo(1);
  });

  it('ignores tracks no frames could be read for', () => {
    const merged = mergeSignatures([
      { signature: [1, 0, 0], weight: 500 },
      { signature: [], weight: 0 },
    ]);
    expect(merged).toEqual([1, 0, 0]);
  });

  it('returns nothing when there is no evidence at all', () => {
    expect(mergeSignatures([])).toEqual([]);
    expect(mergeSignatures([{ signature: [], weight: 0 }])).toEqual([]);
  });
});

describe('the colour veto', () => {
  it('sits clear of two different jerseys and below the same one', () => {
    // Mirrors the worker's measured behaviour: different colours share almost
    // nothing, the same colour under different light shares most of it.
    const different = similarity([1, 0, 0, 0], [0, 0, 1, 0]);
    const sameThroughShade = similarity([0.7, 0.3, 0, 0], [0.55, 0.45, 0, 0]);
    expect(different).toBeLessThan(COLOUR_FLOOR);
    expect(sameThroughShade).toBeGreaterThan(COLOUR_FLOOR);
  });

  it('is a proper intersection, capped at one', () => {
    expect(similarity([0.5, 0.5], [0.5, 0.5])).toBeCloseTo(1);
    expect(similarity([1, 0], [0, 1])).toBe(0);
  });
});

/**
 * Continuity is the part that actually claims "this is the same child", so it
 * is the part that has to be mean. Measured on a real game, continuity with no
 * colour veto pulled in 50 extra fragments and 120s of "athlete"; with it, 8
 * and 51s.
 */
describe('linking one fragment to the next', () => {
  const FRAME = 1920;
  /** A track sitting still at (x, y) between two times. */
  const at = (id: string, from: number, to: number, x: number, y = 400): TrackSeries => ({
    id,
    className: 'player',
    samples: [
      { ts: from, x, y, w: 40, h: 100, confidence: 0.9 },
      { ts: to, x, y, w: 40, h: 100, confidence: 0.9 },
    ],
  });

  it('links a fragment that resumes moments later, close by', () => {
    const link = linkBetween(at('known', 10, 20, 500), at('next', 20.5, 25, 560), FRAME);
    expect(link).not.toBeNull();
    expect(link?.gapSeconds).toBeCloseTo(0.5);
    expect(link?.distancePx).toBeCloseTo(60);
  });

  it('links backwards, so a fragment can extend the athlete earlier', () => {
    const link = linkBetween(at('known', 10, 20, 500), at('before', 5, 9.5, 520), FRAME);
    expect(link).not.toBeNull();
    expect(link?.gapSeconds).toBeCloseTo(0.5);
  });

  it('refuses a silence longer than a child can be vouched for', () => {
    // Anchored to the constant, not to a number that happened to exceed it: the
    // limit moved from 2s to 6s and this test went on passing for a gap that
    // was by then well inside it.
    const beyond = 20 + MAX_LINK_SECONDS + 1;
    expect(linkBetween(at('known', 10, 20, 500), at('later', beyond, beyond + 5, 505), FRAME))
      .toBeNull();
    const within = 20 + MAX_LINK_SECONDS - 0.5;
    expect(linkBetween(at('known', 10, 20, 500), at('later', within, within + 5, 505), FRAME))
      .not.toBeNull();
  });

  /**
   * The reach formula grows without bound, so before it was capped a longer gap
   * did not loosen the distance gate, it removed it: past 3.1s the allowance
   * exceeds a whole frame width, and links measured on production footage
   * reached 1,676px of 1920. Colour cannot catch that — teammates share a shirt
   * — so this is the only thing keeping the child beside yours out of the reel.
   */
  it('never draws a link clear across the court, however long the gap', () => {
    for (const gap of [0.5, 2, 4, MAX_LINK_SECONDS]) {
      const start = 20 + gap;
      const link = linkBetween(at('known', 10, 20, 200), at('far', start, start + 2, 1800), FRAME);
      expect(link, `a ${gap}s gap should not reach 1600px`).toBeNull();
    }
  });

  it('refuses a jump no child could have run', () => {
    // Half a second, most of the way across the court: that is a different kid.
    expect(linkBetween(at('known', 10, 20, 200), at('far', 20.5, 25, 1800), FRAME)).toBeNull();
  });

  it('allows further travel when more time has passed', () => {
    const brief = linkBetween(at('known', 10, 20, 200), at('far', 20.2, 25, 600), FRAME);
    const longer = linkBetween(at('known', 10, 20, 200), at('far', 21.5, 25, 600), FRAME);
    expect(brief).toBeNull();
    expect(longer).not.toBeNull();
  });

  it('refuses two fragments that are on screen together', () => {
    // Overlapping in time means no gap in either direction, so no link at all.
    expect(linkBetween(at('known', 10, 20, 500), at('same-time', 15, 25, 505), FRAME)).toBeNull();
  });

  it('scales its reach with the frame, not with a pixel count', () => {
    const wide = linkBetween(at('known', 10, 20, 500), at('next', 20.5, 25, 900), 3840);
    const narrow = linkBetween(at('known', 10, 20, 500), at('next', 20.5, 25, 900), 640);
    expect(wide).not.toBeNull();
    expect(narrow).toBeNull();
  });
});
