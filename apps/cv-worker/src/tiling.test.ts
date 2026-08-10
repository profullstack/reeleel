import { describe, expect, it } from 'vitest';

import {
  TILE_OVERLAP,
  decodedSize,
  downscaleTensor,
  passesPerFrame,
  tileOffsets,
  tileOrigins,
  tileTensor,
} from './tiling.js';

/**
 * Sliced inference exists because the shipped model has a fixed 416x416 input,
 * so a 1080p frame is scaled by 0.217 before the network sees it. Measured on
 * real footage with these weights: the ball scores 0.54 full-frame where it is
 * found at all, and 0.89 from a tile, with frames the full-frame pass misses
 * entirely coming back at 0.88.
 *
 * The arithmetic below is what maps a detection made inside a tile back onto
 * the frame. Get it wrong and every box lands in the wrong place — silently,
 * because a plausible-looking box is indistinguishable from a correct one
 * without checking the numbers.
 */

const SIZE = 416;

describe('tile geometry', () => {
  it('leaves the frame alone when tiling is off', () => {
    expect(decodedSize(SIZE, 1)).toBe(SIZE);
    expect(tileOffsets(SIZE, 1)).toEqual([0]);
    expect(tileOrigins(SIZE, 1)).toEqual([{ x: 0, y: 0 }]);
    expect(passesPerFrame(1)).toBe(1);
  });

  it('decodes large enough for the tiles to cover it with overlap', () => {
    // 2 tiles sharing 20% => 1.8 tiles wide, not 2.
    expect(decodedSize(SIZE, 2)).toBe(Math.round(SIZE * 1.8));
    expect(decodedSize(SIZE, 3)).toBe(Math.round(SIZE * 2.6));
  });

  it('places the first tile at the origin and the last flush with the edge', () => {
    for (const grid of [2, 3, 4]) {
      const offsets = tileOffsets(SIZE, grid);
      expect(offsets).toHaveLength(grid);
      expect(offsets[0]).toBe(0);
      expect(offsets.at(-1)).toBe(decodedSize(SIZE, grid) - SIZE);
    }
  });

  it('overlaps neighbours, so an object on a seam is whole in one of them', () => {
    const offsets = tileOffsets(SIZE, 3);
    for (let i = 1; i < offsets.length; i += 1) {
      const step = offsets[i]! - offsets[i - 1]!;
      expect(step).toBeLessThan(SIZE);
      expect(SIZE - step).toBeCloseTo(SIZE * TILE_OVERLAP, 0);
    }
  });

  it('never reads past the decoded frame', () => {
    for (const grid of [2, 3, 5]) {
      const frame = decodedSize(SIZE, grid);
      for (const origin of tileOrigins(SIZE, grid)) {
        expect(origin.x + SIZE).toBeLessThanOrEqual(frame);
        expect(origin.y + SIZE).toBeLessThanOrEqual(frame);
      }
    }
  });

  it('counts the full-frame pass in the cost', () => {
    expect(passesPerFrame(2)).toBe(5);
    expect(passesPerFrame(3)).toBe(10);
  });
});

describe('tileTensor', () => {
  const W = 8;
  const H = 8;
  // A frame where every pixel encodes its own position, so a misplaced crop is
  // visible rather than plausible.
  const frame = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const i = (y * W + x) * 3;
      frame[i] = x;
      frame[i + 1] = y;
      frame[i + 2] = 0;
    }
  }

  it('copies the requested square, not the top-left one', () => {
    const size = 2;
    const tile = tileTensor(frame, W, { x: 5, y: 3 }, size);
    const plane = size * size;
    // Red channel carries x, green carries y.
    expect([...tile.slice(0, plane)]).toEqual([5, 6, 5, 6]);
    expect([...tile.slice(plane, plane * 2)]).toEqual([3, 3, 4, 4]);
  });

  it('lays pixels out channel-first, as the model expects', () => {
    const tile = tileTensor(frame, W, { x: 0, y: 0 }, 2);
    expect(tile).toHaveLength(3 * 2 * 2);
    // Blue is zero everywhere in the fixture; if the layout were interleaved
    // this slice would contain x and y values instead.
    expect([...tile.slice(8, 12)]).toEqual([0, 0, 0, 0]);
  });
});

describe('downscaleTensor', () => {
  it('averages each block rather than sampling one pixel', () => {
    const W = 4;
    const H = 4;
    const frame = Buffer.alloc(W * H * 3);
    // Left half 0, right half 100, so a 2x2 result must be 0 and 100 — and a
    // 1x1 result must be 50, which point-sampling could never produce.
    for (let y = 0; y < H; y += 1) {
      for (let x = 0; x < W; x += 1) {
        const i = (y * W + x) * 3;
        const value = x < W / 2 ? 0 : 100;
        frame[i] = value;
        frame[i + 1] = value;
        frame[i + 2] = value;
      }
    }
    expect(downscaleTensor(frame, W, H, 1)[0]).toBe(50);

    const two = downscaleTensor(frame, W, H, 2);
    expect(two[0]).toBe(0);
    expect(two[1]).toBe(100);
  });

  it('produces a full CHW tensor of the requested size', () => {
    const frame = Buffer.alloc(16 * 16 * 3, 7);
    const out = downscaleTensor(frame, 16, 16, 4);
    expect(out).toHaveLength(3 * 4 * 4);
    expect([...out].every((v) => v === 7)).toBe(true);
  });
});
