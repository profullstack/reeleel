import type { Detection } from './geometry.js';

/**
 * Decodes a YOLOX ONNX head.
 *
 * The released YOLOX ONNX files emit raw head output: centre offsets in grid
 * cells and log-space sizes, concatenated across the three feature strides.
 * Decoding is the caller's job, exactly as YOLOX's own onnxruntime demo does
 * it — grid + stride for the centre, exp * stride for the size.
 */
export const YOLOX_STRIDES = [8, 16, 32] as const;

export interface DecodeOptions {
  inputWidth: number;
  inputHeight: number;
  strides?: readonly number[];
  scoreThreshold: number;
}

/** Number of predictions a given input size produces, summed over strides. */
export const predictionCount = (
  width: number,
  height: number,
  strides: readonly number[] = YOLOX_STRIDES,
): number =>
  strides.reduce((total, stride) => total + (width / stride) * (height / stride), 0);

export const decodeYolox = (
  raw: Float32Array | Float64Array,
  attributes: number,
  options: DecodeOptions,
): Detection[] => {
  const strides = options.strides ?? YOLOX_STRIDES;
  const classCount = attributes - 5;
  if (classCount <= 0) return [];

  const detections: Detection[] = [];
  let offset = 0;

  for (const stride of strides) {
    const gridWidth = Math.floor(options.inputWidth / stride);
    const gridHeight = Math.floor(options.inputHeight / stride);

    for (let gy = 0; gy < gridHeight; gy += 1) {
      for (let gx = 0; gx < gridWidth; gx += 1, offset += 1) {
        const base = offset * attributes;
        if (base + attributes > raw.length) return detections;

        const objectness = raw[base + 4] ?? 0;
        // Cheap early exit: objectness caps the final score, so a hopeless
        // cell never pays for the class argmax.
        if (objectness < options.scoreThreshold) continue;

        let bestClass = 0;
        let bestScore = 0;
        for (let c = 0; c < classCount; c += 1) {
          const score = raw[base + 5 + c] ?? 0;
          if (score > bestScore) {
            bestScore = score;
            bestClass = c;
          }
        }

        const score = objectness * bestScore;
        if (score < options.scoreThreshold) continue;

        const cx = ((raw[base] ?? 0) + gx) * stride;
        const cy = ((raw[base + 1] ?? 0) + gy) * stride;
        const w = Math.exp(raw[base + 2] ?? 0) * stride;
        const h = Math.exp(raw[base + 3] ?? 0) * stride;

        detections.push({
          x: cx - w / 2,
          y: cy - h / 2,
          w,
          h,
          score,
          classId: bestClass,
        });
      }
    }
  }

  return detections;
};
