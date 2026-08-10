import type { Detection } from './geometry.js';

/**
 * Decodes a YOLOv8 detection head.
 *
 * Different from YOLOX in three ways that all matter, and none of which are
 * visible in the tensor itself:
 *
 *   - the layout is channel-first, `[1, 4 + classes, anchors]`, where YOLOX is
 *     `[1, anchors, 5 + classes]`;
 *   - there is no objectness column, so the class score *is* the confidence;
 *   - boxes come out already decoded, as centre/size in input pixels, so there
 *     is no grid or stride arithmetic to redo.
 *
 * Feeding one to the other's decoder does not fail. It produces a full set of
 * plausible, wrong boxes — which is why the head is chosen by shape rather than
 * assumed, and why this lives in its own file with its own tests.
 */
export const decodeYolov8 = (
  raw: Float32Array | Float64Array,
  dims: readonly number[],
  scoreThreshold: number,
): Detection[] => {
  const attributes = dims[dims.length - 2] ?? 0;
  const anchors = dims[dims.length - 1] ?? 0;
  const classCount = attributes - 4;
  if (classCount <= 0 || anchors <= 0) return [];

  const detections: Detection[] = [];

  for (let i = 0; i < anchors; i += 1) {
    let bestScore = 0;
    let bestClass = -1;
    for (let c = 0; c < classCount; c += 1) {
      const score = raw[(4 + c) * anchors + i] ?? 0;
      if (score > bestScore) {
        bestScore = score;
        bestClass = c;
      }
    }
    if (bestClass < 0 || bestScore < scoreThreshold) continue;

    const cx = raw[i] ?? 0;
    const cy = raw[anchors + i] ?? 0;
    const w = raw[2 * anchors + i] ?? 0;
    const h = raw[3 * anchors + i] ?? 0;

    detections.push({
      x: cx - w / 2,
      y: cy - h / 2,
      w,
      h,
      score: bestScore,
      classId: bestClass,
    });
  }

  return detections;
};

export type HeadKind = 'yolox' | 'yolov8';

/**
 * Which head produced this tensor.
 *
 * Attribute counts are small (4 + a handful of classes, or 5 + 80) and anchor
 * counts are in the thousands, so the shorter axis is the attribute axis. YOLOX
 * puts it last and YOLOv8 puts it second, which separates them without needing
 * to know either model's class count in advance.
 */
export const headKindFor = (dims: readonly number[]): HeadKind => {
  const second = dims[dims.length - 2] ?? 0;
  const last = dims[dims.length - 1] ?? 0;
  return second < last ? 'yolov8' : 'yolox';
};
