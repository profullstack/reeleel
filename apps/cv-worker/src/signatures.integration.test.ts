import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { similarity } from './appearance.js';
import { computeSignatures } from './signatures.js';

/**
 * The seam a unit test cannot reach: boxes in one coordinate space, frames
 * decoded in another.
 *
 * Tracks are stored in source-video pixels while this reads the 540p proxy, and
 * taking the scale from the decoded file put every torso crop off the edge of
 * the frame. The unit tests all passed; the feature returned a confident zero
 * matches on footage with eight to find. Only measuring real pixels catches it,
 * so this builds a video whose colours are known and checks that a box given in
 * a *larger* space still lands on the right one.
 *
 * Skipped where ffmpeg is absent; the container image has it.
 */

const ffmpeg = spawnSync('ffmpeg', ['-version']);
const available = ffmpeg.status === 0;

let dir: string;
let video: string;

beforeAll(() => {
  if (!available) return;
  dir = mkdtempSync(path.join(tmpdir(), 'reeleel-signatures-'));
  video = path.join(dir, 'bands.mp4');

  /**
   * Two seconds of a 640x360 clip: a red left half and a blue right half. The
   * "source" space the boxes will be quoted in is twice that, so a correct
   * implementation has to halve them before cropping.
   */
  const result = spawnSync(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=c=red:s=320x360:d=2:r=10',
      '-f',
      'lavfi',
      '-i',
      'color=c=blue:s=320x360:d=2:r=10',
      '-filter_complex',
      '[0:v][1:v]hstack=inputs=2[v]',
      '-map',
      '[v]',
      '-pix_fmt',
      'yuv420p',
      video,
    ],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) throw new Error(`could not build the fixture: ${result.stderr}`);
});

afterAll(() => {
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!available)('signatures from real pixels', () => {
  /** A box in 1280x720 space, over a 640x360 video. */
  const box = (x: number) => ({ ts: 1, x, y: 100, w: 200, h: 400 });

  it('scales boxes out of their own space and onto the decoded frame', async () => {
    const result = await computeSignatures({
      input: video,
      ffmpegPath: 'ffmpeg',
      // Twice the video's real size: this is the bug's shape.
      sourceWidth: 1280,
      sourceHeight: 720,
      fps: 10,
      boxes: [
        { track: 'left', ...box(100) },
        { track: 'right', ...box(900) },
      ],
    });

    // Both crops must have landed on actual pixels.
    expect(result.pixels['left']).toBeGreaterThan(0);
    expect(result.pixels['right']).toBeGreaterThan(0);

    const left = result.signatures['left'] ?? [];
    const right = result.signatures['right'] ?? [];
    expect(left.length).toBeGreaterThan(0);
    expect(right.length).toBeGreaterThan(0);

    // The whole point: one landed on red, the other on blue. Get the scaling
    // wrong and both land on the same place, or on nothing.
    expect(similarity(left, right)).toBeLessThan(0.2);
    expect(similarity(left, left)).toBeCloseTo(1);
  });

  it('reads the same shirt as the same shirt from two moments', async () => {
    const result = await computeSignatures({
      input: video,
      ffmpegPath: 'ffmpeg',
      sourceWidth: 1280,
      sourceHeight: 720,
      fps: 10,
      boxes: [
        { track: 'early', ...box(100), ts: 0.5 },
        { track: 'late', ...box(100), ts: 1.5 },
      ],
    });
    expect(
      similarity(result.signatures['early'] ?? [], result.signatures['late'] ?? []),
    ).toBeGreaterThan(0.9);
  });

  it('measures nothing for a box that is off the frame', async () => {
    const result = await computeSignatures({
      input: video,
      ffmpegPath: 'ffmpeg',
      sourceWidth: 1280,
      sourceHeight: 720,
      fps: 10,
      boxes: [{ track: 'gone', ts: 1, x: -4000, y: 100, w: 200, h: 400 }],
    });
    expect(result.signatures['gone']).toBeUndefined();
  });
});
