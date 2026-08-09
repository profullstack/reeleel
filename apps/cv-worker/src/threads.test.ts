import { describe, expect, it } from 'vitest';

/**
 * Why this is pinned.
 *
 * onnxruntime with `intraOpNumThreads: 0` sizes its pool from the cores it can
 * see, and inside a container that is usually the host's core count rather than
 * the cgroup's share. Oversubscribing is not a mild loss — measured on a 4-core
 * machine with YOLOX-Tiny at 416x416:
 *
 *   1 thread   112 ms/frame
 *   2 threads   58 ms/frame
 *   4 threads   65 ms/frame
 *   8 threads  194 ms/frame   <- 3.5x slower than the best
 *
 * So a container given two vCPUs on a 32-core host could land in that last row
 * without anything appearing to be wrong.
 */

/** Mirrors defaultThreads() in index.ts. */
const chooseThreads = (available: number): number => Math.max(1, Math.min(4, available));

describe('choosing a thread count', () => {
  it('uses what the cgroup actually allows', () => {
    expect(chooseThreads(1)).toBe(1);
    expect(chooseThreads(2)).toBe(2);
    expect(chooseThreads(4)).toBe(4);
  });

  it('caps the pool, because more threads only ever cost time here', () => {
    // The measurement that matters: 8 threads was 3.5x slower than 2.
    expect(chooseThreads(8)).toBe(4);
    expect(chooseThreads(32)).toBe(4);
    expect(chooseThreads(128)).toBe(4);
  });

  it('never asks for zero or fewer, which would hand the choice back', () => {
    // Zero is onnxruntime's "you decide", which is the behaviour being replaced.
    expect(chooseThreads(0)).toBe(1);
    expect(chooseThreads(-1)).toBe(1);
  });

  it('still lets an explicit --threads override win', () => {
    // index.ts: number(flags['threads'], defaultThreads()) — the flag is first.
    const resolve = (flag: string | undefined, available: number): number => {
      const parsed = Number(flag);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : chooseThreads(available);
    };
    expect(resolve('8', 4)).toBe(8);
    expect(resolve(undefined, 4)).toBe(4);
    expect(resolve('', 32)).toBe(4);
    // A nonsense value falls back rather than passing garbage to onnxruntime.
    expect(resolve('nope', 2)).toBe(2);
  });
});
