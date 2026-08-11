export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Detection extends Box {
  score: number;
  /** Index into the model's class list. */
  classId: number;
  /**
   * Normalized torso colour histogram, when the caller measured one.
   *
   * Optional because everything that only needs geometry — NMS, letterboxing,
   * the decoders — must keep working without it, and because a model run
   * without frame pixels to hand has no appearance to offer.
   */
  appearance?: number[];
}

/**
 * Letterbox: scale to fit, pad the remainder. Preserves aspect ratio, which
 * matters because a squashed player is a player the detector has not seen.
 */
export interface Letterbox {
  scale: number;
  padX: number;
  padY: number;
  width: number;
  height: number;
}

export const letterbox = (
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
  targetHeight: number,
): Letterbox => {
  const scale = Math.min(targetWidth / sourceWidth, targetHeight / sourceHeight);
  const drawnWidth = Math.round(sourceWidth * scale);
  const drawnHeight = Math.round(sourceHeight * scale);
  return {
    scale,
    padX: Math.floor((targetWidth - drawnWidth) / 2),
    padY: Math.floor((targetHeight - drawnHeight) / 2),
    width: targetWidth,
    height: targetHeight,
  };
};

/** Maps a box from letterboxed model space back to source pixels. */
export const unletterbox = (box: Box, view: Letterbox): Box => ({
  x: (box.x - view.padX) / view.scale,
  y: (box.y - view.padY) / view.scale,
  w: box.w / view.scale,
  h: box.h / view.scale,
});

export const clampBox = (box: Box, width: number, height: number): Box => {
  const x1 = Math.max(0, Math.min(box.x, width));
  const y1 = Math.max(0, Math.min(box.y, height));
  const x2 = Math.max(0, Math.min(box.x + box.w, width));
  const y2 = Math.max(0, Math.min(box.y + box.h, height));
  return { x: x1, y: y1, w: Math.max(0, x2 - x1), h: Math.max(0, y2 - y1) };
};

export const area = (box: Box): number => Math.max(0, box.w) * Math.max(0, box.h);

export const intersection = (a: Box, b: Box): number => {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  return Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
};

export const iou = (a: Box, b: Box): number => {
  const overlap = intersection(a, b);
  const union = area(a) + area(b) - overlap;
  return union <= 0 ? 0 : overlap / union;
};

/**
 * Greedy non-maximum suppression, per class. Detectors emit many overlapping
 * boxes for the same object; without this a single player becomes a crowd and
 * the tracker never settles.
 */
export const nonMaxSuppression = (
  detections: Detection[],
  iouThreshold: number,
  limit = 300,
): Detection[] => {
  const byScore = [...detections].sort((a, b) => b.score - a.score);
  const kept: Detection[] = [];

  for (const candidate of byScore) {
    if (kept.length >= limit) break;
    const overlapsKept = kept.some(
      (chosen) => chosen.classId === candidate.classId && iou(chosen, candidate) > iouThreshold,
    );
    if (!overlapsKept) kept.push(candidate);
  }
  return kept;
};
