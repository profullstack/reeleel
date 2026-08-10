import { describe, expect, it } from 'vitest';

import type { Detection } from './geometry.js';
import { ByteTracker, inflate } from './tracker.js';

/**
 * Why the ball is hardly ever identified.
 *
 * Per-class confidence floors let a faint ball through the filter, and ball
 * *positions* rose 69% — but the number of ball tracks barely moved, which is
 * the tell. Only a confident detection may open a track; a faint one can extend
 * a track that already exists. So every extra ball detection attached itself to
 * the handful of tracks lucky enough to have started at 0.4, and the rest were
 * discarded for having nothing to attach to.
 *
 * The second half is geometry. Overlap is a poor question to ask about a thrown
 * ball: it is a small box that clears several of its own widths between sampled
 * frames, and boxes that do not touch have an IoU of exactly zero however
 * close they are.
 */

const det = (x: number, y: number, w: number, h: number, score: number, classId = 0): Detection => ({
  x,
  y,
  w,
  h,
  score,
  classId,
});

const names = { 0: 'player', 32: 'ball' };

describe('starting a track at the class its own floor', () => {
  it('opens a ball track from detections no player detection could open', () => {
    const tracker = new ByteTracker({
      minLength: 1,
      highThreshold: 0.5,
      lowThreshold: 0.05,
      classHighThreshold: { ball: 0.08 },
    });
    // A ball seen faintly and steadily — never once at the global bar of 0.5.
    for (let f = 0; f < 6; f += 1) {
      tracker.update([det(100 + f * 3, 200, 20, 20, 0.2, 32)], names, f, f / 30);
    }

    const tracks = tracker.results();
    expect(tracks).toHaveLength(1);
    expect(tracks[0]?.className).toBe('ball');
    expect(tracks[0]?.points).toHaveLength(6);
  });

  it('still refuses to open a player track from the same weak evidence', () => {
    const tracker = new ByteTracker({
      minLength: 1,
      highThreshold: 0.5,
      lowThreshold: 0.05,
      classHighThreshold: { ball: 0.08 },
    });
    for (let f = 0; f < 6; f += 1) {
      tracker.update([det(100 + f * 3, 200, 40, 90, 0.2, 0)], names, f, f / 30);
    }
    // The floor is the ball's alone: loosening it must not loosen people.
    expect(tracker.results()).toHaveLength(0);
  });

  it('leaves a class with no override on the global bar', () => {
    const tracker = new ByteTracker({ minLength: 1, highThreshold: 0.5, lowThreshold: 0.05 });
    for (let f = 0; f < 6; f += 1) {
      tracker.update([det(100 + f * 3, 200, 20, 20, 0.2, 32)], names, f, f / 30);
    }
    expect(tracker.results()).toHaveLength(0);
  });
});

describe('buffered overlap for something small and fast', () => {
  it('grows a box by a fraction of its own size, and leaves a zero buffer alone', () => {
    const original = { x: 100, y: 100, w: 20, h: 20 };
    expect(inflate(original, 0)).toEqual(original);
    expect(inflate(original, 0.5)).toEqual({ x: 90, y: 90, w: 40, h: 40 });
  });

  it('follows a ball that clears its own width between frames as one flight', () => {
    const tracker = new ByteTracker({
      minLength: 1,
      highThreshold: 0.5,
      lowThreshold: 0.05,
      classHighThreshold: { ball: 0.08 },
      classBuffer: { ball: 1.5 },
    });
    // 20px wide, moving 30px a frame: consecutive boxes never touch, so plain
    // IoU is zero at every step.
    for (let f = 0; f < 8; f += 1) {
      tracker.update([det(100 + f * 30, 200, 20, 20, 0.3, 32)], names, f, f / 30);
    }

    const tracks = tracker.results();
    expect(tracks).toHaveLength(1);
    expect(tracks[0]?.points).toHaveLength(8);
  });

  it('is what makes the difference — the same flight without a buffer shatters', () => {
    const tracker = new ByteTracker({
      minLength: 1,
      highThreshold: 0.5,
      lowThreshold: 0.05,
      classHighThreshold: { ball: 0.08 },
    });
    for (let f = 0; f < 8; f += 1) {
      tracker.update([det(100 + f * 30, 200, 20, 20, 0.3, 32)], names, f, f / 30);
    }

    // Every frame starts a new track: this is the scatter seen in production.
    expect(tracker.results().length).toBeGreaterThan(1);
  });

  it('does not let a buffered ball steal the ball beside it', () => {
    const tracker = new ByteTracker({
      minLength: 1,
      highThreshold: 0.5,
      lowThreshold: 0.05,
      classHighThreshold: { ball: 0.08 },
      classBuffer: { ball: 1.5 },
    });
    // Two balls, far apart, moving in opposite directions. Buffering must widen
    // the net, not merge distinct objects.
    for (let f = 0; f < 8; f += 1) {
      tracker.update(
        [det(100 + f * 20, 200, 20, 20, 0.3, 32), det(900 - f * 20, 600, 20, 20, 0.3, 32)],
        names,
        f,
        f / 30,
      );
    }
    expect(tracker.results()).toHaveLength(2);
  });

  it('leaves people associating on exactly the geometry they always did', () => {
    const withBuffer = new ByteTracker({ minLength: 1, classBuffer: { ball: 1.5 } });
    const without = new ByteTracker({ minLength: 1 });
    for (let f = 0; f < 10; f += 1) {
      const frame = [det(100 + f * 5, 200, 40, 90, 0.9), det(300 - f * 5, 210, 40, 90, 0.85)];
      withBuffer.update(frame, names, f, f / 30);
      without.update(frame, names, f, f / 30);
    }
    expect(withBuffer.results().map((t) => t.points.length)).toEqual(
      without.results().map((t) => t.points.length),
    );
  });
});
