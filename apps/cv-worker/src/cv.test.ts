import { describe, expect, it } from 'vitest';

import { COCO_CLASSES, mappingFor } from './classes.js';
import { buildFilter, toTensor } from './frames.js';
import { clampBox, iou, letterbox, nonMaxSuppression, unletterbox } from './geometry.js';
import type { Detection } from './geometry.js';
import { ByteTracker } from './tracker.js';
import { decodeYolox, predictionCount } from './yolox.js';

const det = (x: number, y: number, w: number, h: number, score: number, classId = 0): Detection => ({
  x,
  y,
  w,
  h,
  score,
  classId,
});

describe('letterbox', () => {
  it('preserves aspect ratio and centres the padding', () => {
    // 1920x1080 into 416x416 → scale to 416x234, pad 91 top and bottom.
    const view = letterbox(1920, 1080, 416, 416);
    expect(view.scale).toBeCloseTo(416 / 1920, 6);
    expect(view.padX).toBe(0);
    expect(view.padY).toBe(91);
  });

  it('round-trips a box back to source coordinates', () => {
    const view = letterbox(1920, 1080, 416, 416);
    const source = { x: 800, y: 400, w: 120, h: 260 };
    const inModelSpace = {
      x: source.x * view.scale + view.padX,
      y: source.y * view.scale + view.padY,
      w: source.w * view.scale,
      h: source.h * view.scale,
    };
    const back = unletterbox(inModelSpace, view);

    expect(back.x).toBeCloseTo(source.x, 4);
    expect(back.y).toBeCloseTo(source.y, 4);
    expect(back.w).toBeCloseTo(source.w, 4);
    expect(back.h).toBeCloseTo(source.h, 4);
  });

  it('handles portrait footage', () => {
    const view = letterbox(1080, 1920, 416, 416);
    expect(view.padX).toBe(91);
    expect(view.padY).toBe(0);
  });
});

describe('clampBox', () => {
  it('keeps a box inside the frame', () => {
    const clamped = clampBox({ x: -20, y: -10, w: 100, h: 100 }, 640, 480);
    expect(clamped.x).toBe(0);
    expect(clamped.y).toBe(0);
    expect(clamped.w).toBe(80);
    expect(clamped.h).toBe(90);
  });

  it('collapses a box entirely outside the frame', () => {
    expect(clampBox({ x: 900, y: 900, w: 50, h: 50 }, 640, 480).w).toBe(0);
  });
});

describe('iou', () => {
  it('is 1 for identical boxes and 0 for disjoint ones', () => {
    expect(iou({ x: 0, y: 0, w: 10, h: 10 }, { x: 0, y: 0, w: 10, h: 10 })).toBe(1);
    expect(iou({ x: 0, y: 0, w: 10, h: 10 }, { x: 50, y: 50, w: 10, h: 10 })).toBe(0);
  });

  it('computes partial overlap', () => {
    // Half-overlap: intersection 50, union 150.
    expect(iou({ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 0, w: 10, h: 10 })).toBeCloseTo(50 / 150, 6);
  });
});

describe('nonMaxSuppression', () => {
  it('keeps the strongest of a cluster', () => {
    const kept = nonMaxSuppression(
      [det(100, 100, 50, 100, 0.9), det(102, 101, 50, 100, 0.8), det(98, 99, 50, 100, 0.7)],
      0.45,
    );
    expect(kept).toHaveLength(1);
    expect(kept[0]?.score).toBe(0.9);
  });

  it('keeps separate objects', () => {
    expect(nonMaxSuppression([det(0, 0, 50, 100, 0.9), det(300, 0, 50, 100, 0.8)], 0.45)).toHaveLength(2);
  });

  it('never suppresses across classes — a ball on a player is both', () => {
    const kept = nonMaxSuppression([det(100, 100, 50, 100, 0.9, 0), det(100, 100, 50, 100, 0.8, 32)], 0.45);
    expect(kept).toHaveLength(2);
  });

  it('respects the output limit', () => {
    const many = Array.from({ length: 50 }, (_, i) => det(i * 200, 0, 20, 20, 0.9));
    expect(nonMaxSuppression(many, 0.45, 10)).toHaveLength(10);
  });
});

describe('decodeYolox', () => {
  const SIZE = 64;
  const ATTRS = 85;

  it('counts predictions the same way the model lays them out', () => {
    // 416 is the shipped input size; 3549 is what YOLOX emits for it.
    expect(predictionCount(416, 416)).toBe(3549);
    expect(predictionCount(SIZE, SIZE)).toBe(64 * 64 / 64 + 64 * 64 / 256 + 64 * 64 / 1024);
  });

  it('decodes a single planted detection to the right place', () => {
    const total = predictionCount(SIZE, SIZE);
    const raw = new Float32Array(total * ATTRS);

    // First cell of the stride-8 grid, offset half a cell, size exp(0)*8 = 8.
    raw[0] = 0.5; // cx offset
    raw[1] = 0.5; // cy offset
    raw[2] = 0; // log w
    raw[3] = 0; // log h
    raw[4] = 0.9; // objectness
    raw[5] = 0.8; // class 0 (person)

    const decoded = decodeYolox(raw, ATTRS, {
      inputWidth: SIZE,
      inputHeight: SIZE,
      scoreThreshold: 0.5,
    });

    expect(decoded).toHaveLength(1);
    const box = decoded[0];
    expect(box?.classId).toBe(0);
    expect(box?.score).toBeCloseTo(0.72, 5);
    // centre = (0.5 + 0) * 8 = 4, size 8 → top-left at 0.
    expect(box?.x).toBeCloseTo(0, 5);
    expect(box?.y).toBeCloseTo(0, 5);
    expect(box?.w).toBeCloseTo(8, 5);
    expect(box?.h).toBeCloseTo(8, 5);
  });

  it('applies the grid offset for a later cell', () => {
    const total = predictionCount(SIZE, SIZE);
    const raw = new Float32Array(total * ATTRS);

    // Third cell along the first row of the stride-8 grid (gx = 2).
    const base = 2 * ATTRS;
    raw[base] = 0;
    raw[base + 1] = 0;
    raw[base + 2] = 0;
    raw[base + 3] = 0;
    raw[base + 4] = 1;
    raw[base + 5] = 1;

    const decoded = decodeYolox(raw, ATTRS, {
      inputWidth: SIZE,
      inputHeight: SIZE,
      scoreThreshold: 0.5,
    });
    // centre x = (0 + 2) * 8 = 16, width 8 → left edge 12.
    expect(decoded[0]?.x).toBeCloseTo(12, 5);
  });

  it('drops everything below the score threshold', () => {
    const raw = new Float32Array(predictionCount(SIZE, SIZE) * ATTRS);
    raw[4] = 0.4;
    raw[5] = 0.4; // 0.16 combined
    expect(decodeYolox(raw, ATTRS, { inputWidth: SIZE, inputHeight: SIZE, scoreThreshold: 0.5 })).toHaveLength(0);
  });

  it('returns nothing for a malformed attribute count', () => {
    expect(decodeYolox(new Float32Array(10), 3, { inputWidth: SIZE, inputHeight: SIZE, scoreThreshold: 0.1 })).toEqual([]);
  });
});

describe('class mapping', () => {
  it('maps COCO person and sports ball to soccer classes', () => {
    expect(COCO_CLASSES[0]).toBe('person');
    expect(COCO_CLASSES[32]).toBe('sports ball');

    const mapping = mappingFor('soccer', ['player', 'ball']);
    expect(mapping.byIndex[0]).toBe('player');
    expect(mapping.byIndex[32]).toBe('ball');
    expect(mapping.missing).toEqual([]);
  });

  it('reports the classes a COCO model simply cannot know', () => {
    const mapping = mappingFor('soccer', ['player', 'ball', 'referee', 'goalkeeper', 'goal']);
    expect(mapping.produces).toEqual(['player', 'ball']);
    // Honest reporting rather than guessing a role from a person box.
    expect(mapping.missing).toEqual(['referee', 'goalkeeper', 'goal']);
  });

  it('has nothing to offer an unsupported sport', () => {
    expect(mappingFor('quidditch', ['player']).produces).toEqual([]);
  });
});

describe('ByteTracker', () => {
  const names = { 0: 'player', 32: 'ball' };

  it('follows one object across frames as a single track', () => {
    const tracker = new ByteTracker({ minLength: 1 });
    for (let f = 0; f < 10; f += 1) {
      tracker.update([det(100 + f * 5, 200, 40, 90, 0.9)], names, f, f / 30);
    }
    const tracks = tracker.results();
    expect(tracks).toHaveLength(1);
    expect(tracks[0]?.points).toHaveLength(10);
    expect(tracks[0]?.className).toBe('player');
  });

  it('keeps two objects apart', () => {
    const tracker = new ByteTracker({ minLength: 1 });
    for (let f = 0; f < 6; f += 1) {
      tracker.update(
        [det(100 + f * 4, 200, 40, 90, 0.9), det(600 - f * 4, 210, 40, 90, 0.85)],
        names,
        f,
        f / 30,
      );
    }
    expect(tracker.results()).toHaveLength(2);
  });

  it('rescues a track from a low-confidence detection — the BYTE idea', () => {
    const tracker = new ByteTracker({ minLength: 1, highThreshold: 0.5, lowThreshold: 0.1 });
    tracker.update([det(100, 200, 40, 90, 0.9)], names, 0, 0);
    tracker.update([det(105, 200, 40, 90, 0.9)], names, 1, 0.03);
    // Occluded: still detected, but weakly.
    tracker.update([det(110, 200, 40, 90, 0.2)], names, 2, 0.06);
    tracker.update([det(115, 200, 40, 90, 0.9)], names, 3, 0.1);

    const tracks = tracker.results();
    expect(tracks).toHaveLength(1);
    expect(tracks[0]?.points).toHaveLength(4);
  });

  it('does not start a track from a weak detection alone', () => {
    const tracker = new ByteTracker({ minLength: 1, highThreshold: 0.5, lowThreshold: 0.1 });
    for (let f = 0; f < 5; f += 1) tracker.update([det(100, 200, 40, 90, 0.2)], names, f, f / 30);
    expect(tracker.results()).toHaveLength(0);
  });

  it('closes a track once the object is gone for too long', () => {
    const tracker = new ByteTracker({ minLength: 1, maxAge: 2 });
    tracker.update([det(100, 200, 40, 90, 0.9)], names, 0, 0);
    for (let f = 1; f < 8; f += 1) tracker.update([], names, f, f / 30);
    tracker.update([det(400, 200, 40, 90, 0.9)], names, 8, 0.26);

    // The reappearance is a new object, not a resurrection of the old one.
    expect(tracker.results()).toHaveLength(2);
  });

  it('discards tracks too short to be real', () => {
    const tracker = new ByteTracker({ minLength: 3 });
    tracker.update([det(100, 200, 40, 90, 0.9)], names, 0, 0);
    expect(tracker.results()).toHaveLength(0);
  });

  it('never associates across classes', () => {
    const tracker = new ByteTracker({ minLength: 1 });
    tracker.update([det(100, 200, 40, 90, 0.9, 0)], names, 0, 0);
    // Same place, different class: must not extend the player track.
    tracker.update([det(100, 200, 40, 90, 0.9, 32)], names, 1, 0.03);
    expect(tracker.results()).toHaveLength(2);
  });
});

describe('frame decoding', () => {
  it('builds an ffmpeg filter that samples, scales and pads', () => {
    const filter = buildFilter({
      input: 'x.mp4',
      ffmpegPath: 'ffmpeg',
      sourceWidth: 1920,
      sourceHeight: 1080,
      targetWidth: 416,
      targetHeight: 416,
      frameStride: 3,
      fps: 30,
    });
    expect(filter).toContain('select=not(mod(n\\,3))');
    expect(filter).toContain('force_original_aspect_ratio=decrease');
    expect(filter).toContain('pad=416:416');
  });

  it('omits the select filter when every frame is wanted', () => {
    const filter = buildFilter({
      input: 'x.mp4',
      ffmpegPath: 'ffmpeg',
      sourceWidth: 640,
      sourceHeight: 480,
      targetWidth: 416,
      targetHeight: 416,
      frameStride: 1,
      fps: 30,
    });
    expect(filter).not.toContain('select=');
  });

  it('converts interleaved BGR bytes into a CHW tensor', () => {
    // Two pixels: (1,2,3) and (4,5,6) in BGR order.
    const pixels = Buffer.from([1, 2, 3, 4, 5, 6]);
    const tensor = toTensor(pixels, 2, 1);

    expect(Array.from(tensor)).toEqual([1, 4, 2, 5, 3, 6]);
  });
});
