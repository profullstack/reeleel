/**
 * Sliced inference, for objects the model cannot see when the whole frame is
 * squeezed into its input.
 *
 * The shipped detector has a fixed 416x416 input, so a 1920x1080 frame is
 * scaled by 0.217 before it ever reaches the network. Players survive that;
 * a basketball does not. Measured on real footage with the same weights, the
 * ball scored 0.54 confidence full-frame and 0.89 from a tile, and one frame
 * where the full-frame pass found nothing at all yielded a 0.88 detection once
 * tiled.
 *
 * The frame is therefore decoded larger than the model input and cut into
 * overlapping tiles, each of which is fed to the network at its native size.
 * The full-frame pass is kept as well: tiles are smaller than a close-up
 * player, and an object larger than a tile is only whole in the full view.
 * Overlap exists so an object sitting on a seam is still intact in a neighbour.
 */

/** Fraction of a tile shared with the next one along each axis. */
export const TILE_OVERLAP = 0.2;

/**
 * Side length to decode a frame at, so `grid` tiles of `size` cover it with
 * `TILE_OVERLAP` to spare. Grid 1 means no tiling and no enlargement.
 */
export const decodedSize = (size: number, grid: number): number =>
  grid <= 1 ? size : Math.round(size * (grid - (grid - 1) * TILE_OVERLAP));

/**
 * Top-left offsets of each tile along one axis, evenly spread so the first
 * starts at zero and the last ends flush with the frame.
 */
export const tileOffsets = (size: number, grid: number): number[] => {
  if (grid <= 1) return [0];
  const span = decodedSize(size, grid) - size;
  return Array.from({ length: grid }, (_unused, i) => Math.round((span * i) / (grid - 1)));
};

/** Every tile origin, row-major. */
export const tileOrigins = (size: number, grid: number): { x: number; y: number }[] => {
  const offsets = tileOffsets(size, grid);
  return offsets.flatMap((y) => offsets.map((x) => ({ x, y })));
};

/** How many inferences one frame costs at this grid, counting the full view. */
export const passesPerFrame = (grid: number): number => (grid <= 1 ? 1 : grid * grid + 1);

/**
 * A tile of an RGB frame, as the CHW float tensor the model expects.
 *
 * Pixels are copied rather than resampled — the whole point is to hand the
 * network real pixels at its native resolution instead of a shrunken copy.
 */
export const tileTensor = (
  pixels: Buffer | Uint8Array,
  frameWidth: number,
  origin: { x: number; y: number },
  size: number,
): Float32Array => {
  const out = new Float32Array(3 * size * size);
  const plane = size * size;
  for (let y = 0; y < size; y += 1) {
    const sourceRow = (origin.y + y) * frameWidth;
    const targetRow = y * size;
    for (let x = 0; x < size; x += 1) {
      const source = (sourceRow + origin.x + x) * 3;
      const target = targetRow + x;
      out[target] = pixels[source] ?? 0;
      out[plane + target] = pixels[source + 1] ?? 0;
      out[2 * plane + target] = pixels[source + 2] ?? 0;
    }
  }
  return out;
};

/**
 * The whole frame shrunk to the model input, by box-averaging each destination
 * pixel's source block. Nearest-neighbour would alias a thin moving object out
 * of existence, which is the failure this file exists to fix.
 */
export const downscaleTensor = (
  pixels: Buffer | Uint8Array,
  frameWidth: number,
  frameHeight: number,
  size: number,
): Float32Array => {
  const out = new Float32Array(3 * size * size);
  const plane = size * size;
  const scaleX = frameWidth / size;
  const scaleY = frameHeight / size;

  for (let y = 0; y < size; y += 1) {
    const y0 = Math.floor(y * scaleY);
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * scaleY));
    for (let x = 0; x < size; x += 1) {
      const x0 = Math.floor(x * scaleX);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * scaleX));

      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let sy = y0; sy < y1 && sy < frameHeight; sy += 1) {
        for (let sx = x0; sx < x1 && sx < frameWidth; sx += 1) {
          const source = (sy * frameWidth + sx) * 3;
          r += pixels[source] ?? 0;
          g += pixels[source + 1] ?? 0;
          b += pixels[source + 2] ?? 0;
          n += 1;
        }
      }
      if (n === 0) continue;
      const target = y * size + x;
      out[target] = r / n;
      out[plane + target] = g / n;
      out[2 * plane + target] = b / n;
    }
  }
  return out;
};
