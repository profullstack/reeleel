/**
 * What a player looks like, reduced to something two tracks can be compared on.
 *
 * Re-identification matched on box overlap alone, which by construction only
 * finds an athlete where they were already known to be: it can confirm a
 * binding across a re-detection, but it can never discover the same child
 * somewhere else in the game. On real footage that left an athlete identified
 * for 31.7s of a 300s match, with every signal that follows them dark for the
 * other 90%.
 *
 * A jersey is the one thing about a child that a detector can see and that
 * stays the same all afternoon, so that is what this measures: a coarse colour
 * histogram of the torso. Deliberately coarse — the point is to tell one team's
 * shirt from the other's and one shirt from the floor, not to recognise a face.
 * Anything finer would invite false confidence, and the cost of a confident
 * wrong answer here is another family's child in your highlight reel.
 */

/** Where the shirt is, as fractions of a player's box. */
const TORSO = { x0: 0.2, x1: 0.8, y0: 0.15, y1: 0.5 };

/** 12 hues x 2 saturations for colour, plus 4 lightness bins for grey. */
export const HUE_BINS = 12;
export const SAT_BINS = 2;
export const GREY_BINS = 4;
export const BIN_COUNT = HUE_BINS * SAT_BINS + GREY_BINS;

/**
 * Below these a pixel has no usable hue — a white shirt, a black shoe, a shadow
 * — and binning it by hue would scatter it at random across the spectrum. Those
 * pixels carry their lightness instead, which is what actually distinguishes a
 * white jersey from a dark one.
 */
const MIN_SATURATION = 0.2;
const MIN_VALUE = 0.15;

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * The torso of a box, scaled into decoded-frame pixels and clamped to the
 * frame. Returns null when nothing usable is left — an off-screen or
 * sub-pixel box has no appearance to measure, and inventing one from a
 * clamped sliver would be worse than skipping it.
 */
export const torsoRect = (
  box: Box,
  scale: number,
  frameWidth: number,
  frameHeight: number,
): Rect | null => {
  const x0 = Math.round((box.x + box.w * TORSO.x0) * scale);
  const x1 = Math.round((box.x + box.w * TORSO.x1) * scale);
  const y0 = Math.round((box.y + box.h * TORSO.y0) * scale);
  const y1 = Math.round((box.y + box.h * TORSO.y1) * scale);

  const clamped: Rect = {
    x0: Math.max(0, Math.min(frameWidth, x0)),
    x1: Math.max(0, Math.min(frameWidth, x1)),
    y0: Math.max(0, Math.min(frameHeight, y0)),
    y1: Math.max(0, Math.min(frameHeight, y1)),
  };
  if (clamped.x1 - clamped.x0 < 2 || clamped.y1 - clamped.y0 < 2) return null;
  return clamped;
};

export interface Hsv {
  /** Degrees, 0..360. */
  h: number;
  s: number;
  v: number;
}

/** Standard conversion, on 0..255 channels. */
export const toHsv = (r: number, g: number, b: number): Hsv => {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const delta = max - min;

  let h = 0;
  if (delta > 0) {
    if (max === rn) h = 60 * (((gn - bn) / delta) % 6);
    else if (max === gn) h = 60 * ((bn - rn) / delta + 2);
    else h = 60 * ((rn - gn) / delta + 4);
  }
  if (h < 0) h += 360;
  return { h, s: max === 0 ? 0 : delta / max, v: max };
};

/** Which bin a colour belongs in; grey and near-black go to the lightness bins. */
export const binFor = ({ h, s, v }: Hsv): number => {
  if (s < MIN_SATURATION || v < MIN_VALUE) {
    const bin = Math.min(GREY_BINS - 1, Math.floor(v * GREY_BINS));
    return HUE_BINS * SAT_BINS + Math.max(0, bin);
  }
  const hue = Math.min(HUE_BINS - 1, Math.floor(h / (360 / HUE_BINS)));
  const sat = s < 0.5 ? 0 : 1;
  return hue * SAT_BINS + sat;
};

/**
 * Adds one crop's colours into an accumulator. BGR because that is the order
 * the frame decoder emits, matching what the detector was trained on.
 */
export const accumulate = (
  pixels: Buffer | Uint8Array,
  frameWidth: number,
  rect: Rect,
  into: Float64Array,
): number => {
  let counted = 0;
  for (let y = rect.y0; y < rect.y1; y += 1) {
    const row = y * frameWidth;
    for (let x = rect.x0; x < rect.x1; x += 1) {
      const at = (row + x) * 3;
      const b = pixels[at] ?? 0;
      const g = pixels[at + 1] ?? 0;
      const r = pixels[at + 2] ?? 0;
      const bin = binFor(toHsv(r, g, b));
      into[bin] = (into[bin] ?? 0) + 1;
      counted += 1;
    }
  }
  return counted;
};

/** Sum to one, so signatures from crops of different sizes are comparable. */
export const normalize = (histogram: Float64Array | number[]): number[] => {
  let total = 0;
  for (const value of histogram) total += value;
  if (total <= 0) return Array.from({ length: histogram.length }, () => 0);
  return Array.from(histogram, (value) => value / total);
};

/**
 * Histogram intersection: 1 for identical signatures, 0 for no shared colour at
 * all. Chosen over a Euclidean distance because it degrades gracefully when a
 * crop catches some background — the extra mass simply fails to overlap,
 * rather than dominating the distance.
 */
export const similarity = (a: number[], b: number[]): number => {
  const length = Math.min(a.length, b.length);
  let shared = 0;
  for (let i = 0; i < length; i += 1) shared += Math.min(a[i] ?? 0, b[i] ?? 0);
  return shared;
};
