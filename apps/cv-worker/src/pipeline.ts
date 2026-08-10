import * as ort from 'onnxruntime-node';

import { requireBinary } from '@reeleel/core';

import { mappingFor } from './classes.js';
import { frameStream, toTensor, viewFor } from './frames.js';
import { clampBox, nonMaxSuppression, unletterbox } from './geometry.js';
import type { Detection } from './geometry.js';
import {
  decodedSize,
  downscaleTensor,
  passesPerFrame,
  tileOrigins,
  tileTensor,
} from './tiling.js';
import { ByteTracker } from './tracker.js';
import type { Track } from './tracker.js';
import { decodeYolox } from './yolox.js';

export interface PipelineOptions {
  input: string;
  modelPath: string;
  sport: string;
  classes: string[];
  frameStride: number;
  inferenceSize: number;
  /**
   * Slice each frame into `tileGrid` x `tileGrid` tiles and run the model on
   * each at native resolution, in addition to the whole frame. 1 disables it.
   *
   * The ball is the reason. With the whole frame squeezed into a fixed 416x416
   * input it is detected at 0.54 confidence where it is found at all; from a
   * tile the same weights score 0.89, and frames the full-frame pass misses
   * entirely come back. It costs grid^2 + 1 inferences per frame.
   */
  tileGrid?: number;
  minConfidence: number;
  iouThreshold: number;
  sourceWidth: number;
  sourceHeight: number;
  fps: number;
  threads: number;
  signal?: AbortSignal;
  onProgress?: (frames: number) => void;
}

export interface PipelineResult {
  tracks: {
    class: string;
    confidence: number;
    points: { frame: number; ts: number; x: number; y: number; w: number; h: number; confidence: number }[];
  }[];
  framesProcessed: number;
  detections: number;
  /** Requested classes this model cannot produce, reported rather than faked. */
  unsupportedClasses: string[];
}

export const createSession = async (
  modelPath: string,
  threads: number,
): Promise<ort.InferenceSession> =>
  ort.InferenceSession.create(modelPath, {
    executionProviders: ['cpu'],
    // 0 lets onnxruntime pick; the PRD requires CPU-only to be a first-class path.
    intraOpNumThreads: threads,
    graphOptimizationLevel: 'all',
  });

/**
 * The spatial size this model will actually accept.
 *
 * Most exported detectors — including the YOLOX-Tiny we ship — bake a fixed
 * input shape into the graph, `[1, 3, 416, 416]`. Feeding anything else fails
 * inside onnxruntime with "Got invalid dimensions for input", which is what
 * every preset did: fast asked for 512, balanced 768, accurate 1280, and so
 * detection could not succeed at all. The preset is a request, not an
 * instruction; a model with a static shape overrules it.
 *
 * Returns null when the model's spatial dims are dynamic (a string or a
 * negative number), in which case the requested size is genuinely free.
 */
export const staticInputSize = (session: ort.InferenceSession): number | null => {
  const metadata = session.inputMetadata[0];
  if (metadata === undefined || !metadata.isTensor) return null;

  // NCHW: height and width are the last two dimensions.
  const shape = metadata.shape;
  const height = shape[shape.length - 2];
  const width = shape[shape.length - 1];
  const fixed = (value: unknown): number | null =>
    typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;

  const h = fixed(height);
  const w = fixed(width);
  if (h === null || w === null) return null;
  // Letterboxing assumes a square input; a non-square static model is not
  // something this pipeline can silently accommodate.
  return h === w ? h : Math.min(h, w);
};

export const runPipeline = async (options: PipelineOptions): Promise<PipelineResult> => {
  const ffmpeg = requireBinary('ffmpeg');
  const mapping = mappingFor(options.sport, options.classes);
  const session = await createSession(options.modelPath, options.threads);

  const inputName = session.inputNames[0];
  const outputName = session.outputNames[0];
  if (inputName === undefined || outputName === undefined) {
    throw new Error('The model exposes no input or output tensor.');
  }

  // The model has the final say on its own input size.
  const required = staticInputSize(session);
  const size = required ?? options.inferenceSize;
  if (required !== null && required !== options.inferenceSize) {
    // Diagnostics go to stderr; stdout is reserved for the result object.
    process.stderr.write(
      `note: this model has a fixed ${required}x${required} input; ` +
        `using that instead of the requested ${options.inferenceSize}.\n`,
    );
  }

  /**
   * Decode larger than the model input when tiling, so each tile carries real
   * pixels rather than a shrunken copy. Letterboxing is computed against the
   * decoded frame, which is the space every detection is mapped back into.
   */
  const grid = Math.max(1, Math.floor(options.tileGrid ?? 1));
  const decoded = decodedSize(size, grid);
  const origins = tileOrigins(size, grid);
  if (grid > 1) {
    process.stderr.write(
      `note: tiling ${grid}x${grid} at ${decoded}x${decoded} — ` +
        `${passesPerFrame(grid)} inferences per frame, for small objects the ` +
        `whole-frame pass cannot resolve.\n`,
    );
  }

  const view = viewFor({
    input: options.input,
    ffmpegPath: ffmpeg,
    sourceWidth: options.sourceWidth,
    sourceHeight: options.sourceHeight,
    targetWidth: decoded,
    targetHeight: decoded,
    frameStride: options.frameStride,
    fps: options.fps,
  });

  const tracker = new ByteTracker({
    highThreshold: Math.max(options.minConfidence, 0.4),
    lowThreshold: options.minConfidence,
    iouThreshold: options.iouThreshold,
  });

  let framesProcessed = 0;
  let detectionCount = 0;

  for await (const frame of frameStream({
    input: options.input,
    ffmpegPath: ffmpeg,
    sourceWidth: options.sourceWidth,
    sourceHeight: options.sourceHeight,
    targetWidth: decoded,
    targetHeight: decoded,
    frameStride: options.frameStride,
    fps: options.fps,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  })) {
    if (options.signal?.aborted === true) break;

    /** One pass of the model, with results placed in decoded-frame space. */
    const runPass = async (
      tensorData: Float32Array,
      offsetX: number,
      offsetY: number,
      scale: number,
    ): Promise<Detection[]> => {
      const tensor = new ort.Tensor('float32', tensorData, [1, 3, size, size]);
      const output = await session.run({ [inputName]: tensor });
      const head = output[outputName];
      if (head === undefined) return [];

      const raw = head.data as Float32Array;
      const attributes = head.dims[head.dims.length - 1] ?? 0;
      return decodeYolox(raw, attributes, {
        inputWidth: size,
        inputHeight: size,
        scoreThreshold: options.minConfidence,
      }).map((d) => ({
        ...d,
        x: d.x * scale + offsetX,
        y: d.y * scale + offsetY,
        w: d.w * scale,
        h: d.h * scale,
      }));
    };

    const found: Detection[] =
      grid <= 1
        ? await runPass(toTensor(frame.pixels, size, size), 0, 0, 1)
        : // The whole frame, because a close-up player is larger than a tile
          // and is only ever whole in the full view...
          (await runPass(
            downscaleTensor(frame.pixels, decoded, decoded, size),
            0,
            0,
            decoded / size,
          )).concat(
            // ...then each tile at native resolution, which is what lets the
            // model resolve the ball at all.
            (
              await Promise.all(
                origins.map((origin) =>
                  runPass(
                    tileTensor(frame.pixels, decoded, origin, size),
                    origin.x,
                    origin.y,
                    1,
                  ),
                ),
              )
            ).flat(),
          );

    // Drop classes this sport does not care about before NMS, so a stray
    // "bench" never suppresses a player. NMS also fuses the duplicates that
    // overlapping tiles and the full-frame pass necessarily produce.
    const relevant = found.filter((d) => mapping.byIndex[d.classId] !== undefined);
    const kept = nonMaxSuppression(relevant, options.iouThreshold);

    const inSourceSpace: Detection[] = kept.map((detection) => {
      const box = clampBox(unletterbox(detection, view), options.sourceWidth, options.sourceHeight);
      return { ...box, score: detection.score, classId: detection.classId };
    });

    detectionCount += inSourceSpace.length;
    tracker.update(inSourceSpace, mapping.byIndex, frame.index, frame.ts);

    framesProcessed += 1;
    options.onProgress?.(framesProcessed);
  }

  await session.release();

  return {
    tracks: tracker.results().map(toOutput),
    framesProcessed,
    detections: detectionCount,
    unsupportedClasses: mapping.missing,
  };
};

const toOutput = (track: Track): PipelineResult['tracks'][number] => ({
  class: track.className,
  confidence: Number(track.confidence.toFixed(4)),
  points: track.points.map((point) => ({
    frame: point.frame,
    ts: Number(point.ts.toFixed(3)),
    x: Math.round(point.x),
    y: Math.round(point.y),
    w: Math.round(point.w),
    h: Math.round(point.h),
    confidence: Number(point.confidence.toFixed(4)),
  })),
});
