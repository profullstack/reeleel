import { describe, expect, it } from 'vitest';

import {
  accumulate,
  BIN_COUNT,
  binFor,
  normalize,
  similarity,
  toHsv,
  torsoRect,
} from './appearance.js';
import { decodePlanFor } from './signatures.js';

/**
 * The safety property under all of this: a signature that cannot tell two teams
 * apart is useless, and a signature that confidently equates them is dangerous.
 * These pin both directions.
 */

/** A solid-colour BGR frame, so a crop's expected histogram is known exactly. */
const solidFrame = (width: number, height: number, [b, g, r]: [number, number, number]): Buffer => {
  const buffer = Buffer.alloc(width * height * 3);
  for (let i = 0; i < width * height; i += 1) {
    buffer[i * 3] = b;
    buffer[i * 3 + 1] = g;
    buffer[i * 3 + 2] = r;
  }
  return buffer;
};

const signatureOf = (frame: Buffer, width: number, height: number): number[] => {
  const bins = new Float64Array(BIN_COUNT);
  const rect = torsoRect({ x: 0, y: 0, w: width, h: height }, 1, width, height);
  expect(rect).not.toBeNull();
  accumulate(frame, width, rect!, bins);
  return normalize(bins);
};

describe('colour conversion', () => {
  it('reads primaries at the hues they belong to', () => {
    expect(toHsv(255, 0, 0).h).toBeCloseTo(0);
    expect(toHsv(0, 255, 0).h).toBeCloseTo(120);
    expect(toHsv(0, 0, 255).h).toBeCloseTo(240);
  });

  it('reports grey as unsaturated whatever its lightness', () => {
    expect(toHsv(128, 128, 128).s).toBe(0);
    expect(toHsv(255, 255, 255).s).toBe(0);
    expect(toHsv(0, 0, 0).s).toBe(0);
  });
});

describe('binning', () => {
  it('sends washed-out and near-black pixels to the lightness bins, not a random hue', () => {
    // A white shirt has a hue, arithmetically; it means nothing. Binning it by
    // hue would scatter white jerseys across the spectrum at random.
    const white = binFor(toHsv(250, 250, 250));
    const black = binFor(toHsv(4, 4, 6));
    expect(white).toBeGreaterThanOrEqual(24);
    expect(black).toBeGreaterThanOrEqual(24);
    expect(white).not.toBe(black);
  });

  it('keeps saturated colours apart', () => {
    expect(binFor(toHsv(255, 0, 0))).not.toBe(binFor(toHsv(0, 0, 255)));
  });

  it('never returns a bin outside the histogram', () => {
    for (let r = 0; r <= 255; r += 17) {
      for (let g = 0; g <= 255; g += 17) {
        for (let b = 0; b <= 255; b += 17) {
          const bin = binFor(toHsv(r, g, b));
          expect(bin).toBeGreaterThanOrEqual(0);
          expect(bin).toBeLessThan(BIN_COUNT);
        }
      }
    }
  });
});

describe('the torso crop', () => {
  it('takes the shirt, not the head, the legs or the air beside them', () => {
    const rect = torsoRect({ x: 100, y: 200, w: 100, h: 200 }, 1, 1920, 1080);
    expect(rect).toEqual({ x0: 120, x1: 180, y0: 230, y1: 300 });
  });

  it('scales into decoded-frame pixels', () => {
    // Boxes arrive in source pixels; the frame is decoded smaller.
    const rect = torsoRect({ x: 100, y: 200, w: 100, h: 200 }, 0.5, 960, 540);
    expect(rect).toEqual({ x0: 60, x1: 90, y0: 115, y1: 150 });
  });

  it('refuses a box with nothing left in frame rather than inventing a sliver', () => {
    expect(torsoRect({ x: -500, y: 0, w: 100, h: 200 }, 1, 960, 540)).toBeNull();
    expect(torsoRect({ x: 0, y: 0, w: 1, h: 1 }, 1, 960, 540)).toBeNull();
  });
});

describe('deciding what to decode, and at what scale', () => {
  it('scales boxes from their own space, not from the file being read', () => {
    /**
     * The bug this exists for: tracks are in source-video pixels (1920x1080)
     * while the file read is the 540p proxy. Deriving the space from the proxy
     * scaled every crop by 1, put every torso off the right edge of the frame,
     * and returned a confident zero matches on footage with eight to find.
     */
    const plan = decodePlanFor(1920, 1080, 960);
    expect(plan.decodeWidth).toBe(960);
    expect(plan.decodeHeight).toBe(540);
    expect(plan.scale).toBe(0.5);
  });

  it('never upscales past the footage it was given', () => {
    const plan = decodePlanFor(640, 360, 960);
    expect(plan.decodeWidth).toBe(640);
    expect(plan.scale).toBe(1);
  });

  it('keeps the aspect ratio, so a box’s y scales like its x', () => {
    const plan = decodePlanFor(1440, 1080, 720);
    expect(plan.scale).toBe(0.5);
    expect(plan.decodeHeight).toBe(540);
  });

  it('survives a video with no readable width instead of dividing by zero', () => {
    const plan = decodePlanFor(0, 0, 960);
    expect(Number.isFinite(plan.scale)).toBe(true);
    expect(plan.decodeHeight).toBeGreaterThan(0);
  });
});

describe('comparing two players', () => {
  it('matches a shirt against itself', () => {
    const red = signatureOf(solidFrame(40, 80, [30, 30, 200]), 40, 80);
    expect(similarity(red, red)).toBeCloseTo(1);
  });

  it('separates two teams wearing different colours', () => {
    const red = signatureOf(solidFrame(40, 80, [30, 30, 200]), 40, 80);
    const blue = signatureOf(solidFrame(40, 80, [200, 30, 30]), 40, 80);
    // The whole point. If this ever creeps up, the wrong child ends up in a reel.
    expect(similarity(red, blue)).toBeLessThan(0.1);
  });

  it('separates a white shirt from a black one', () => {
    const white = signatureOf(solidFrame(40, 80, [245, 245, 245]), 40, 80);
    const black = signatureOf(solidFrame(40, 80, [12, 12, 12]), 40, 80);
    expect(similarity(white, black)).toBeLessThan(0.1);
  });

  it('still recognises a shirt through a shading change', () => {
    // Same jersey, one player in sun and one in shadow: value drops, hue holds.
    const lit = signatureOf(solidFrame(40, 80, [40, 40, 220]), 40, 80);
    const shaded = signatureOf(solidFrame(40, 80, [26, 26, 140]), 40, 80);
    expect(similarity(lit, shaded)).toBeGreaterThan(0.8);
  });

  it('normalises away crop size, so a close-up matches a distant shot', () => {
    const near = signatureOf(solidFrame(80, 160, [30, 180, 40]), 80, 160);
    const far = signatureOf(solidFrame(12, 24, [30, 180, 40]), 12, 24);
    expect(similarity(near, far)).toBeCloseTo(1, 1);
  });

  it('gives an empty signature no similarity to anything', () => {
    const nothing = normalize(new Float64Array(BIN_COUNT));
    const red = signatureOf(solidFrame(40, 80, [30, 30, 200]), 40, 80);
    expect(similarity(nothing, red)).toBe(0);
  });
});
