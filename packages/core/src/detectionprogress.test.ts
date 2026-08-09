import { describe, expect, it } from 'vitest';

/**
 * Detection reports progress once per video, so with a single video the bar
 * jumped to 70% and stayed there for the whole inference pass — minutes of CPU
 * work that looks exactly like a hang, and was reported as one.
 *
 * The worker has always written `analyzed N frames` to stderr. These cover the
 * parsing that turns those lines into a moving bar: the arithmetic lives in
 * analyzeProject's stderr handler, so it is reproduced here rather than
 * exported, and pinned against the worker's real output format.
 */

/** The worker's line, from apps/cv-worker/src/index.ts. */
const workerLine = (frames: number): string => `analyzed ${frames} frames\n`;

const latestFrameCount = (chunk: string): number | null => {
  let frames: number | null = null;
  for (const match of chunk.matchAll(/analyzed (\d+) frames/g)) {
    frames = Number(match[1]);
  }
  return frames;
};

describe('reading frame progress from the worker', () => {
  it('parses the line the worker actually writes', () => {
    expect(latestFrameCount(workerLine(50))).toBe(50);
  });

  it('takes the newest count when a chunk carries several lines', () => {
    // stderr arrives in chunks, not lines; the worker writes every 50 frames.
    const chunk = [workerLine(50), workerLine(100), workerLine(150)].join('');
    expect(latestFrameCount(chunk)).toBe(150);
  });

  it('ignores chunks with no progress in them', () => {
    expect(latestFrameCount('note: this model has a fixed 416x416 input\n')).toBeNull();
    expect(latestFrameCount('')).toBeNull();
  });

  it('survives a line split across two chunks without inventing a number', () => {
    // The tail of a split line must not parse as a smaller count.
    expect(latestFrameCount('analyzed 12')).toBeNull();
    expect(latestFrameCount('00 frames\n')).toBeNull();
  });

  it('reads progress out of a mixed chunk', () => {
    const chunk = `note: something\n${workerLine(400)}done: nearly\n`;
    expect(latestFrameCount(chunk)).toBe(400);
  });
});

describe('turning frames into a bar and an ETA', () => {
  // detection occupies 0.2 -> 0.7 of the job; one video takes the whole span.
  const start = 0.2;
  const span = 0.5;
  const bar = (frames: number, expected: number): number =>
    start + span * (expected > 0 ? Math.min(1, frames / expected) : 0);

  it('moves across detection instead of sitting at 70%', () => {
    expect(bar(0, 1000)).toBeCloseTo(0.2);
    expect(bar(500, 1000)).toBeCloseTo(0.45);
    expect(bar(1000, 1000)).toBeCloseTo(0.7);
  });

  it('never overshoots when the frame estimate was low', () => {
    // Duration times fps is an estimate; real files run over it.
    expect(bar(1500, 1000)).toBeCloseTo(0.7);
  });

  it('falls back to the stage start when duration or fps is unknown', () => {
    expect(bar(500, 0)).toBeCloseTo(0.2);
  });

  it('estimates time left from the observed rate', () => {
    const eta = (frames: number, expected: number, elapsed: number): number | null => {
      const rate = elapsed > 0 ? frames / elapsed : 0;
      return expected > 0 && rate > 0 ? Math.max(0, (expected - frames) / rate) : null;
    };
    // 200 frames in 10s is 20/s; 800 to go is 40s.
    expect(eta(200, 1000, 10)).toBeCloseTo(40);
    expect(eta(1000, 1000, 50)).toBeCloseTo(0);
    expect(eta(0, 1000, 0)).toBeNull();
  });

  it('derives the expected frame count the way the pipeline samples', () => {
    const expectedFrames = (durationSeconds: number, fps: number, stride: number): number =>
      fps > 0 && durationSeconds > 0
        ? Math.max(1, Math.floor((durationSeconds * fps) / stride))
        : 0;

    // A 60-minute game at 30fps, balanced preset samples every 2nd frame.
    expect(expectedFrames(3600, 30, 2)).toBe(54_000);
    // fast skips more, so there is less to do.
    expect(expectedFrames(3600, 30, 5)).toBe(21_600);
    expect(expectedFrames(0, 30, 2)).toBe(0);
    expect(expectedFrames(3600, 0, 2)).toBe(0);
  });
});
