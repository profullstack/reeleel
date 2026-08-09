import * as ort from 'onnxruntime-node';

import { requireBinary } from '@reeleel/core';

import { mappingFor } from './classes.js';
import { frameStream, toTensor, viewFor } from './frames.js';
import { clampBox, nonMaxSuppression, unletterbox } from './geometry.js';
import type { Detection } from './geometry.js';
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

export const runPipeline = async (options: PipelineOptions): Promise<PipelineResult> => {
  const ffmpeg = requireBinary('ffmpeg');
  const mapping = mappingFor(options.sport, options.classes);
  const session = await createSession(options.modelPath, options.threads);

  const inputName = session.inputNames[0];
  const outputName = session.outputNames[0];
  if (inputName === undefined || outputName === undefined) {
    throw new Error('The model exposes no input or output tensor.');
  }

  const size = options.inferenceSize;
  const view = viewFor({
    input: options.input,
    ffmpegPath: ffmpeg,
    sourceWidth: options.sourceWidth,
    sourceHeight: options.sourceHeight,
    targetWidth: size,
    targetHeight: size,
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
    targetWidth: size,
    targetHeight: size,
    frameStride: options.frameStride,
    fps: options.fps,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  })) {
    if (options.signal?.aborted === true) break;

    const tensor = new ort.Tensor('float32', toTensor(frame.pixels, size, size), [1, 3, size, size]);
    const output = await session.run({ [inputName]: tensor });
    const head = output[outputName];
    if (head === undefined) continue;

    const raw = head.data as Float32Array;
    const attributes = head.dims[head.dims.length - 1] ?? 0;

    const decoded = decodeYolox(raw, attributes, {
      inputWidth: size,
      inputHeight: size,
      scoreThreshold: options.minConfidence,
    });

    // Drop classes this sport does not care about before NMS, so a stray
    // "bench" never suppresses a player.
    const relevant = decoded.filter((d) => mapping.byIndex[d.classId] !== undefined);
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
