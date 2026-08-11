import { describe, expect, it } from 'vitest';

import { BIN_COUNT } from './appearance.js';
import { ByteTracker } from './tracker.js';
import type { Detection } from './geometry.js';

/**
 * One track, two children.
 *
 * Association is overlap plus a constant-velocity guess, and neither can tell
 * one child from another. The moment that costs is re-acquisition: `maxAge` of
 * 30 frames lets a track survive a second of absence, and greedy IoU is happy to
 * hand the surviving identity to whoever now stands in that space.
 *
 * Measured on the shipped tracker: a player at x=900 who leaves at frame 30,
 * followed at frame 45 by an opponent arriving at x=905, produced **one** track
 * spanning both children. Nothing downstream can undo that — re-identification
 * vets one track against another, so a track that is already two children has no
 * seam left to find, and its colour signature is a blend that matches neither.
 * That is how a reel followed #14 in black.
 */

const hist = (parts: Record<number, number>): number[] => {
  const out = new Array<number>(BIN_COUNT).fill(0);
  for (const [bin, value] of Object.entries(parts)) out[Number(bin)] = value;
  const total = out.reduce((sum, value) => sum + value, 0);
  return out.map((value) => value / total);
};

const WHITE = hist({ 27: 0.62, 26: 0.1, 2: 0.13, 5: 0.15 });
const BLACK = hist({ 24: 0.6, 25: 0.08, 2: 0.13, 5: 0.15 });

const CLASSES = { 0: 'player' };

/** The reported sequence: one child leaves a spot, another takes it. */
const runSwap = (appearance: { first?: number[]; second?: number[] }): ByteTracker => {
  const tracker = new ByteTracker({
    highThreshold: 0.5,
    lowThreshold: 0.1,
    iouThreshold: 0.2,
    maxAge: 30,
    minLength: 3,
  });

  for (let frame = 0; frame < 90; frame += 1) {
    const detections: Detection[] = [];
    if (frame < 30) {
      detections.push({
        classId: 0,
        score: 0.9,
        x: 900,
        y: 400,
        w: 70,
        h: 170,
        ...(appearance.first === undefined ? {} : { appearance: appearance.first }),
      });
    }
    if (frame >= 45) {
      detections.push({
        classId: 0,
        score: 0.9,
        x: 905,
        y: 400,
        w: 70,
        h: 170,
        ...(appearance.second === undefined ? {} : { appearance: appearance.second }),
      });
    }
    tracker.update(detections, CLASSES, frame, frame / 30);
  }
  return tracker;
};

describe('a track that spans two children', () => {
  it('glues them together when nothing but geometry is available', () => {
    // Unchanged behaviour, and the reason the fix has to exist: a pipeline that
    // measures no colour still tracks exactly as it always did.
    expect(runSwap({}).results()).toHaveLength(1);
  });

  it('splits them once the shirts disagree', () => {
    const tracks = runSwap({ first: WHITE, second: BLACK }).results();
    expect(tracks).toHaveLength(2);

    const [white, black] = tracks;
    expect(white?.points.at(-1)?.frame).toBeLessThan(45);
    expect(black?.points[0]?.frame).toBeGreaterThanOrEqual(45);
  });

  it('still re-acquires the same child across the same gap', () => {
    // The gate must cost nothing when the shirt is the one that went away: this
    // is an ordinary occlusion, and splitting it would be a regression.
    expect(runSwap({ first: WHITE, second: WHITE }).results()).toHaveLength(1);
  });

  it('never blocks a track that is merely moving between frames', () => {
    // A track with no missed frame associates on geometry alone. Gating every
    // frame on colour would punish motion blur and a turning player.
    const tracker = new ByteTracker({ highThreshold: 0.5, lowThreshold: 0.1, iouThreshold: 0.2 });
    for (let frame = 0; frame < 40; frame += 1) {
      tracker.update(
        [{ classId: 0, score: 0.9, x: 400 + frame * 6, y: 400, w: 70, h: 170, appearance: WHITE }],
        CLASSES,
        frame,
        frame / 30,
      );
    }
    expect(tracker.results()).toHaveLength(1);
  });
});
