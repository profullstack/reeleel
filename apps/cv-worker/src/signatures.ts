import { accumulate, BIN_COUNT, normalize, torsoRect } from './appearance.js';
import { frameStream } from './frames.js';

/** One box to look at, in source-video pixels. */
export interface SignatureBox {
  track: string;
  ts: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SignatureRequest {
  input: string;
  /**
   * Injected rather than resolved here, so this module depends on nothing but
   * a frame decoder — which is what lets it be run standalone against a real
   * video to check the matching before trusting it with anyone's reel.
   */
  ffmpegPath: string;
  sourceWidth: number;
  sourceHeight: number;
  fps: number;
  boxes: SignatureBox[];
  /** Frames to look at per second of footage. */
  samplesPerSecond?: number;
  /** Width to decode at; a jersey needs colour, not detail. */
  decodeWidth?: number;
  signal?: AbortSignal;
}

export interface SignatureResult {
  /** Track id → normalized colour histogram. */
  signatures: Record<string, number[]>;
  /** Track id → how many pixels went into it, so thin evidence can be refused. */
  pixels: Record<string, number>;
  framesRead: number;
}

/**
 * Which decoded frame a box should be measured on.
 *
 * Decoding every frame to sample a handful would cost minutes for nothing, and
 * seeking to each box individually costs more than reading straight through.
 * Instead the video is read once at a coarse stride and every box is snapped to
 * its nearest decoded frame — a player has not moved meaningfully in the eighth
 * of a second that costs, and their shirt has not changed colour at all.
 */
export const frameIndexFor = (ts: number, fps: number, stride: number): number =>
  Math.max(0, Math.round((ts * fps) / stride) * stride);

/**
 * Colour signatures for a set of tracks, from one pass over the video.
 *
 * Runs on whatever file it is given — the 540p proxy is deliberate and
 * sufficient: this measures the colour of a shirt, and downscaling averages
 * noise out of it rather than destroying anything that matters.
 */
export const computeSignatures = async (
  request: SignatureRequest,
): Promise<SignatureResult> => {
  const fps = request.fps > 0 ? request.fps : 30;
  const perSecond = request.samplesPerSecond ?? 2;
  const stride = Math.max(1, Math.round(fps / perSecond));

  const decodeWidth = Math.min(request.decodeWidth ?? 960, request.sourceWidth);
  const scale = request.sourceWidth > 0 ? decodeWidth / request.sourceWidth : 1;
  const decodeHeight = Math.max(2, Math.round(request.sourceHeight * scale));

  // Boxes bucketed by the frame they will be measured on, so each decoded frame
  // is a single lookup rather than a scan of every box.
  const byFrame = new Map<number, SignatureBox[]>();
  for (const box of request.boxes) {
    const index = frameIndexFor(box.ts, fps, stride);
    const existing = byFrame.get(index);
    if (existing === undefined) byFrame.set(index, [box]);
    else existing.push(box);
  }

  const bins = new Map<string, Float64Array>();
  const pixels: Record<string, number> = {};
  let framesRead = 0;

  for await (const frame of frameStream({
    input: request.input,
    ffmpegPath: request.ffmpegPath,
    sourceWidth: request.sourceWidth,
    sourceHeight: request.sourceHeight,
    targetWidth: decodeWidth,
    targetHeight: decodeHeight,
    frameStride: stride,
    fps,
    ...(request.signal === undefined ? {} : { signal: request.signal }),
  })) {
    framesRead += 1;
    const due = byFrame.get(frame.index);
    if (due === undefined) continue;

    for (const box of due) {
      const rect = torsoRect(box, scale, decodeWidth, decodeHeight);
      if (rect === null) continue;
      let accumulator = bins.get(box.track);
      if (accumulator === undefined) {
        accumulator = new Float64Array(BIN_COUNT);
        bins.set(box.track, accumulator);
      }
      pixels[box.track] = (pixels[box.track] ?? 0) + accumulate(frame.pixels, decodeWidth, rect, accumulator);
    }
  }

  const signatures: Record<string, number[]> = {};
  for (const [track, accumulator] of bins) signatures[track] = normalize(accumulator);
  return { signatures, pixels, framesRead };
};
