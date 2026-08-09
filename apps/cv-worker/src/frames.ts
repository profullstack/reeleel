import { spawn } from 'node:child_process';

import { letterbox } from './geometry.js';
import type { Letterbox } from './geometry.js';

export interface FrameStreamOptions {
  input: string;
  ffmpegPath: string;
  sourceWidth: number;
  sourceHeight: number;
  targetWidth: number;
  targetHeight: number;
  /** Run the detector on every Nth frame; the tracker covers the gaps. */
  frameStride: number;
  fps: number;
  signal?: AbortSignal;
}

export interface Frame {
  /** Index in the ORIGINAL video, not in the sampled sequence. */
  index: number;
  ts: number;
  /** Interleaved BGR bytes, already letterboxed to the model's input size. */
  pixels: Buffer;
}

/**
 * Decodes frames through FFmpeg rather than a native binding.
 *
 * FFmpeg is already a hard dependency and already installed in the image, so
 * this avoids adding OpenCV — a large native dependency — purely to read
 * frames. It also lets FFmpeg do the letterboxing in C, which is far faster
 * than resampling in JavaScript.
 *
 * BGR because that is the channel order YOLOX was trained with.
 */
export const buildFilter = (options: FrameStreamOptions): string => {
  const stride = Math.max(1, Math.floor(options.frameStride));
  const parts: string[] = [];
  // `select` keeps every Nth decoded frame; `-fps_mode passthrough` stops
  // FFmpeg from duplicating frames to hit a target rate.
  if (stride > 1) parts.push(`select=not(mod(n\\,${stride}))`);
  parts.push(
    `scale=${options.targetWidth}:${options.targetHeight}:force_original_aspect_ratio=decrease`,
  );
  parts.push(
    `pad=${options.targetWidth}:${options.targetHeight}:(ow-iw)/2:(oh-ih)/2:color=black`,
  );
  return parts.join(',');
};

export const viewFor = (options: FrameStreamOptions): Letterbox =>
  letterbox(
    options.sourceWidth,
    options.sourceHeight,
    options.targetWidth,
    options.targetHeight,
  );

export const frameStream = async function* (options: FrameStreamOptions): AsyncGenerator<Frame> {
  const stride = Math.max(1, Math.floor(options.frameStride));
  const frameBytes = options.targetWidth * options.targetHeight * 3;

  const child = spawn(
    options.ffmpegPath,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      options.input,
      '-vf',
      buildFilter(options),
      '-fps_mode',
      'passthrough',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'bgr24',
      '-',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );

  const abort = (): void => {
    child.kill('SIGTERM');
  };
  options.signal?.addEventListener('abort', abort, { once: true });

  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  let pending = Buffer.alloc(0);
  let sampled = 0;

  try {
    for await (const chunk of child.stdout) {
      pending = Buffer.concat([pending, chunk as Buffer]);
      while (pending.length >= frameBytes) {
        const pixels = pending.subarray(0, frameBytes);
        pending = pending.subarray(frameBytes);

        const index = sampled * stride;
        sampled += 1;
        yield { index, ts: options.fps > 0 ? index / options.fps : 0, pixels };
      }
      if (options.signal?.aborted === true) break;
    }
  } finally {
    options.signal?.removeEventListener('abort', abort);
    child.kill('SIGTERM');
  }

  const code = child.exitCode;
  if (code !== null && code !== 0 && sampled === 0) {
    throw new Error(`ffmpeg failed to decode ${options.input}: ${stderr.trim().split('\n').at(-1) ?? ''}`);
  }
};

/** BGR bytes → CHW float tensor, which is what the model expects. */
export const toTensor = (pixels: Buffer, width: number, height: number): Float32Array => {
  const plane = width * height;
  const tensor = new Float32Array(plane * 3);

  for (let i = 0; i < plane; i += 1) {
    const base = i * 3;
    // YOLOX takes raw 0..255 values; no scaling or mean subtraction.
    tensor[i] = pixels[base] ?? 0;
    tensor[plane + i] = pixels[base + 1] ?? 0;
    tensor[plane * 2 + i] = pixels[base + 2] ?? 0;
  }
  return tensor;
};
