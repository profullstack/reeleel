import { describe, expect, it } from 'vitest';

import { parseClassBuffer, parseClassConfidence } from './index.js';

/**
 * A basketball is a handful of pixels and the model is right to be unsure about
 * it; a player fills a fifth of the frame and a 0.08 "person" is junk. Holding
 * both to one number meant the ball was judged by the standard a person needs.
 *
 * Measured over 20s of a real game at the shipped 2x2 grid:
 *
 *   floor   ball tracks / positions   rim positions   player tracks
 *   0.25         15 / 173                  316             279
 *   0.18         16 / 206                  351             294
 *   0.12         17 / 253                  379             285
 *   0.08         17 / 293                  403             313
 *   0.05         16 / 330                  427             294
 *
 * Track count stays flat while positions nearly double, which is the shape of
 * better recall rather than new phantoms — a noisier detector would invent
 * short tracks, not lengthen the ones already there.
 */

describe('per-class detection floors', () => {
  it('reads the pairs a preset sends', () => {
    expect(parseClassConfidence('ball=0.08,hoop=0.15')).toEqual({ ball: 0.08, hoop: 0.15 });
  });

  it('tolerates whitespace around names and values', () => {
    expect(parseClassConfidence(' ball = 0.08 ')).toEqual({ ball: 0.08 });
    expect(parseClassConfidence('ball=0.08, hoop=0.15')).toEqual({ ball: 0.08, hoop: 0.15 });
  });

  it('is absent rather than empty when nothing is asked for', () => {
    expect(parseClassConfidence(undefined)).toEqual({});
    expect(parseClassConfidence('')).toEqual({});
  });

  /**
   * A typo in a preset should cost the ball some recall, not take a
   * twenty-minute detection pass down with it.
   */
  it('drops malformed pairs instead of throwing', () => {
    expect(parseClassConfidence('ball')).toEqual({});
    expect(parseClassConfidence('ball=')).toEqual({});
    expect(parseClassConfidence('ball=abc')).toEqual({});
    expect(parseClassConfidence('=0.5')).toEqual({});
    expect(parseClassConfidence('ball=0.08,broken,hoop=0.15')).toEqual({
      ball: 0.08,
      hoop: 0.15,
    });
  });

  it('refuses values outside a probability', () => {
    // A floor above 1 detects nothing; a floor of 0 or below detects everything.
    expect(parseClassConfidence('ball=1.5')).toEqual({});
    expect(parseClassConfidence('ball=0')).toEqual({});
    expect(parseClassConfidence('ball=-0.2')).toEqual({});
  });
});

/**
 * Buffers are a distance, not a probability, so they share the parser but not
 * its ceiling — the useful values for a basketball are greater than 1, which is
 * the whole reason the plain overlap test fails on it.
 */
describe('per-class association buffers', () => {
  it('accepts the values a ball actually needs', () => {
    expect(parseClassBuffer('ball=1.5')).toEqual({ ball: 1.5 });
    expect(parseClassBuffer('ball=2.5,puck=1.5')).toEqual({ ball: 2.5, puck: 1.5 });
  });

  it('still refuses nonsense', () => {
    expect(parseClassBuffer('ball=0')).toEqual({});
    expect(parseClassBuffer('ball=-1')).toEqual({});
    expect(parseClassBuffer('ball=abc')).toEqual({});
    // Far enough that every ball on court would match every other one.
    expect(parseClassBuffer('ball=99')).toEqual({});
  });

  it('is absent rather than empty when nothing is asked for', () => {
    expect(parseClassBuffer(undefined)).toEqual({});
  });
});
