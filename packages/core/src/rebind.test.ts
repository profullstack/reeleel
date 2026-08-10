import { describe, expect, it } from 'vitest';

import { trackSimilarity } from './tracks.js';
import type { TrackSeries } from './scoring.js';

/**
 * Re-detection assigns new track ids, so replacing a video's tracks used to
 * discard the one piece of work only a human can do — three re-identifications
 * in one evening, the last after a ten-minute detection pass.
 *
 * Positions survive even though ids do not: the athlete was in the same place
 * on the same frames whichever run observed them. These pin the matching rule,
 * because a re-bind that picks the wrong child is worse than asking again.
 */

const series = (
  id: string,
  from: number,
  to: number,
  at: (ts: number) => { x: number; y: number },
): TrackSeries => ({
  id,
  className: 'player',
  samples: Array.from({ length: Math.round((to - from) * 4) + 1 }, (_unused, i) => {
    const ts = from + i / 4;
    return { ts, ...at(ts), w: 40, h: 100, confidence: 0.9 };
  }),
});

const walking = (offset = 0) => (ts: number) => ({ x: 100 + ts * 10 + offset, y: 300 });

describe('finding the same athlete in a fresh set of tracks', () => {
  it('matches a track to its own re-detection', () => {
    const before = series('old', 0, 20, walking());
    // The same person, detected again with slightly different boxes.
    const after = series('new', 0, 20, walking(3));
    expect(trackSimilarity(before, after)).toBeGreaterThan(0.7);
  });

  it('scores zero against someone who is never on screen at the same time', () => {
    const before = series('old', 0, 20, walking());
    const later = series('other', 120, 140, walking());
    expect(trackSimilarity(before, later)).toBe(0);
  });

  it('scores low against someone elsewhere on the court at the same moment', () => {
    const before = series('old', 0, 20, walking());
    const across = series('other', 0, 20, walking(600));
    expect(trackSimilarity(before, across)).toBe(0);
  });

  /**
   * The guard against a confident wrong answer: a single frame of overlap is
   * not evidence, however well the boxes happen to line up on it.
   */
  it('discounts a match built on almost no shared frames', () => {
    const before = series('old', 0, 20, walking());
    const glimpse = series('brief', 10, 10.25, walking());
    expect(trackSimilarity(before, glimpse)).toBeLessThan(0.3);
  });

  it('prefers the better of two overlapping candidates', () => {
    const before = series('old', 0, 20, walking());
    const close = series('close', 0, 20, walking(5));
    const further = series('further', 0, 20, walking(35));
    expect(trackSimilarity(before, close)).toBeGreaterThan(trackSimilarity(before, further));
  });

  it('handles an empty track without dividing by zero', () => {
    const before = series('old', 0, 20, walking());
    const empty: TrackSeries = { id: 'empty', className: 'player', samples: [] };
    expect(trackSimilarity(before, empty)).toBe(0);
    expect(trackSimilarity(empty, before)).toBe(0);
  });
});
