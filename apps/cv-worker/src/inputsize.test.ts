import { describe, expect, it } from 'vitest';

import { staticInputSize } from './pipeline.js';

/**
 * The bug this pins down: the YOLOX-Tiny we ship bakes `[1, 3, 416, 416]` into
 * the graph, and every preset asked for something else — fast 512, balanced
 * 768, accurate 1280. onnxruntime rejected all three with
 *
 *   Got invalid dimensions for input: images
 *   index: 2 Got: 768 Expected: 416
 *
 * so detection could not succeed under any setting. The preset is a request;
 * a model with a static shape overrules it.
 */

/** Just the shape of InferenceSession that staticInputSize actually reads. */
const sessionWith = (shape: ReadonlyArray<number | string>, isTensor = true) =>
  ({ inputMetadata: [{ name: 'images', isTensor, shape }] }) as never;

describe('staticInputSize', () => {
  it('reports the fixed size the shipped YOLOX-Tiny demands', () => {
    expect(staticInputSize(sessionWith([1, 3, 416, 416]))).toBe(416);
  });

  it('returns null when the spatial dims are symbolic, so the preset is free', () => {
    expect(staticInputSize(sessionWith([1, 3, 'height', 'width']))).toBeNull();
    expect(staticInputSize(sessionWith(['batch', 3, 'h', 'w']))).toBeNull();
  });

  it('treats a negative dimension as dynamic, which is how ORT marks it', () => {
    expect(staticInputSize(sessionWith([1, 3, -1, -1]))).toBeNull();
  });

  it('ignores a dynamic batch dimension, which says nothing about the size', () => {
    expect(staticInputSize(sessionWith(['batch', 3, 640, 640]))).toBe(640);
  });

  it('takes the smaller side of a non-square model rather than guessing', () => {
    // Letterboxing assumes a square input; the short side is the safe choice.
    expect(staticInputSize(sessionWith([1, 3, 416, 640]))).toBe(416);
  });

  it('returns null for a non-tensor input, which it cannot reason about', () => {
    expect(staticInputSize(sessionWith([1, 3, 416, 416], false))).toBeNull();
  });

  it('returns null when the model declares no inputs at all', () => {
    expect(staticInputSize({ inputMetadata: [] } as never)).toBeNull();
  });

  it('rejects a zero dimension rather than building an empty tensor', () => {
    expect(staticInputSize(sessionWith([1, 3, 0, 0]))).toBeNull();
  });

  /** The concrete regression: none of the presets may be passed through. */
  it('overrules every preset when the model is fixed at 416', () => {
    const model = sessionWith([1, 3, 416, 416]);
    for (const requested of [512, 768, 1280]) {
      const size = staticInputSize(model) ?? requested;
      expect(size, `preset asked for ${requested}`).toBe(416);
    }
  });
});
