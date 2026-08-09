import type { TrackSeries } from './scoring.js';
import { sampleAt, velocityAt } from './scoring.js';
import type { AspectRatio, CameraMode } from './types.js';

/**
 * Virtual Cameraman: turns tracks into a smooth crop path over wide footage.
 *
 * The whole job is a tug-of-war between two failure modes. Snap the crop to the
 * player every frame and you get jitter that is unwatchable. Smooth it too hard
 * and the player walks out of frame. So: pick a target per sample, smooth the
 * target (not the output), then clamp to the source so we never crop off-canvas.
 */

export interface CropKeyframe {
  ts: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CameraPathInput {
  mode: CameraMode;
  aspect: AspectRatio;
  sourceWidth: number;
  sourceHeight: number;
  startTs: number;
  endTs: number;
  /** Samples per second of crop path. */
  sampleRate?: number;
  focal: TrackSeries | null;
  ball: TrackSeries | null;
  others?: TrackSeries[];
  /**
   * Smallest crop height as a fraction of source height. Cropping tighter than
   * this throws away real resolution and the export starts to look soft.
   */
  minCropFraction?: number;
  /** 0 = no smoothing, 1 = frozen. */
  smoothing?: number;
}

export const aspectValue = (aspect: AspectRatio): number => {
  switch (aspect) {
    case '16:9':
      return 16 / 9;
    case '9:16':
      return 9 / 16;
    case '1:1':
      return 1;
  }
};

interface Point {
  x: number;
  y: number;
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

/** Where the camera wants to look at `ts`, before smoothing. */
const targetFor = (input: CameraPathInput, ts: number): Point | null => {
  const focal = input.focal === null ? null : sampleAt(input.focal, ts);
  const ball = input.ball === null ? null : sampleAt(input.ball, ts);

  switch (input.mode) {
    case 'wide':
      return { x: input.sourceWidth / 2, y: input.sourceHeight / 2 };

    case 'follow-ball':
      return ball ?? focal;

    case 'follow-player':
      return focal ?? ball;

    case 'follow-action': {
      // Bias toward the player but lean toward the ball when it is in play, so
      // a pass stays legible without the frame lurching away from the athlete.
      if (focal === null) return ball;
      if (ball === null) return focal;
      return { x: focal.x * 0.65 + ball.x * 0.35, y: focal.y * 0.65 + ball.y * 0.35 };
    }
  }
};

/**
 * Lead the subject slightly in its direction of travel. A camera operator does
 * this instinctively; without it the crop always feels a beat behind.
 */
const anticipate = (input: CameraPathInput, ts: number, point: Point): Point => {
  if (input.focal === null || input.mode === 'wide') return point;
  const velocity = velocityAt(input.focal, ts);
  if (velocity === null) return point;
  const lead = 0.35;
  return { x: point.x + velocity.x * lead, y: point.y + velocity.y * lead };
};

export const computeCropPath = (input: CameraPathInput): CropKeyframe[] => {
  const rate = input.sampleRate ?? 5;
  const smoothing = clamp(input.smoothing ?? 0.82, 0, 0.99);
  const minFraction = clamp(input.minCropFraction ?? 0.55, 0.2, 1);
  const targetAspect = aspectValue(input.aspect);

  // Largest crop of the requested aspect that fits inside the source, scaled
  // down to minFraction so there is room to move without upscaling.
  const maxWidth = Math.min(input.sourceWidth, input.sourceHeight * targetAspect);
  const maxHeight = maxWidth / targetAspect;
  const cropWidth = Math.round(maxWidth * minFraction);
  const cropHeight = Math.round(maxHeight * minFraction);

  const keyframes: CropKeyframe[] = [];
  let smoothed: Point | null = null;

  for (let ts = input.startTs; ts <= input.endTs; ts += 1 / rate) {
    const raw = targetFor(input, ts);
    const fallback: Point = { x: input.sourceWidth / 2, y: input.sourceHeight / 2 };
    const desired = anticipate(input, ts, raw ?? fallback);

    smoothed =
      smoothed === null
        ? desired
        : {
            x: smoothed.x * smoothing + desired.x * (1 - smoothing),
            y: smoothed.y * smoothing + desired.y * (1 - smoothing),
          };

    keyframes.push({
      ts,
      x: Math.round(clamp(smoothed.x - cropWidth / 2, 0, input.sourceWidth - cropWidth)),
      y: Math.round(clamp(smoothed.y - cropHeight / 2, 0, input.sourceHeight - cropHeight)),
      width: cropWidth,
      height: cropHeight,
    });
  }

  return keyframes;
};

/** Mean absolute frame-to-frame movement — a proxy for how jittery a path is. */
export const pathJitter = (path: CropKeyframe[]): number => {
  if (path.length < 2) return 0;
  let total = 0;
  for (let i = 1; i < path.length; i += 1) {
    const previous = path[i - 1];
    const current = path[i];
    if (previous === undefined || current === undefined) continue;
    total += Math.hypot(current.x - previous.x, current.y - previous.y);
  }
  return total / (path.length - 1);
};

/**
 * FFmpeg `crop` accepts expressions over `t`. We emit a piecewise-linear
 * expression so one filter call follows the whole path — far cheaper than
 * re-encoding per keyframe.
 */
export const toCropExpression = (path: CropKeyframe[], axis: 'x' | 'y'): string => {
  if (path.length === 0) return '0';
  const first = path[0];
  if (first === undefined) return '0';
  if (path.length === 1) return String(first[axis]);

  // Built back-to-front so each `if` falls through to the earlier segment.
  let expression = String(path[path.length - 1]?.[axis] ?? 0);
  for (let i = path.length - 1; i >= 1; i -= 1) {
    const previous = path[i - 1];
    const current = path[i];
    if (previous === undefined || current === undefined) continue;
    const span = current.ts - previous.ts;
    const slope = span === 0 ? 0 : (current[axis] - previous[axis]) / span;
    const segment = `(${previous[axis]}+(t-${previous.ts.toFixed(3)})*${slope.toFixed(3)})`;
    expression = `if(lt(t,${current.ts.toFixed(3)}),${segment},${expression})`;
  }
  return expression;
};

export const OUTPUT_DIMENSIONS: Record<AspectRatio, { width: number; height: number }> = {
  '16:9': { width: 1920, height: 1080 },
  '9:16': { width: 1080, height: 1920 },
  '1:1': { width: 1080, height: 1080 },
};
