import { describe, expect, it } from 'vitest';

/**
 * The worker writes more than progress to stderr — the thread pool it chose,
 * that it overrode the requested input size, which classes a model cannot
 * produce. `run()` collects all of it into a string that is only read when the
 * run *fails*, so on a successful run those lines reached nobody.
 *
 * This covers the split: progress drives the bar, everything else becomes a log
 * line. The rules live in analyzeProject's stderr handler, so they are
 * reproduced here and pinned against the worker's real output.
 */

interface Line {
  message: string;
  level: 'info' | 'warn';
}

/** Mirrors the diagnostic half of the handler in analyze.ts. */
const diagnostics = (chunk: string): Line[] =>
  chunk
    .split('\n')
    .map((line) => line.trim())
    .filter((text) => text.length > 0 && !text.startsWith('analyzed '))
    .map((text) => ({
      message: `worker: ${text}`,
      level: text.startsWith('note:') ? ('warn' as const) : ('info' as const),
    }));

describe('surfacing worker diagnostics', () => {
  it('keeps the line that says which thread pool was used', () => {
    // The measurement the thread fix exists to expose.
    const chunk = 'threads: using 4 (cgroup-aware 4, visible cores 32)\n';
    expect(diagnostics(chunk)).toEqual([
      { message: 'worker: threads: using 4 (cgroup-aware 4, visible cores 32)', level: 'info' },
    ]);
  });

  it('marks a note as a warning, because it reports something overridden', () => {
    const chunk = 'note: this model has a fixed 416x416 input; using that instead of 768.\n';
    expect(diagnostics(chunk)[0]?.level).toBe('warn');
  });

  it('drops progress lines, which drive the bar rather than the log', () => {
    // Every 50 frames; logging each would bury everything else.
    expect(diagnostics('analyzed 50 frames\nanalyzed 100 frames\n')).toEqual([]);
  });

  it('separates diagnostics from progress in one mixed chunk', () => {
    const chunk = ['threads: using 2 (cgroup-aware 2, visible cores 8)', 'analyzed 50 frames', 'done: 3600 frames, 812 detections, 14 tracks in 61s'].join('\n');
    expect(diagnostics(chunk).map((line) => line.message)).toEqual([
      'worker: threads: using 2 (cgroup-aware 2, visible cores 8)',
      'worker: done: 3600 frames, 812 detections, 14 tracks in 61s',
    ]);
  });

  it('ignores the blank lines a newline-terminated write leaves behind', () => {
    expect(diagnostics('\n\n  \n')).toEqual([]);
  });

  it('keeps the summary line, which is how a run reports what it found', () => {
    const chunk = 'done: 3600 frames, 812 detections, 14 tracks in 61s\n';
    expect(diagnostics(chunk)[0]?.message).toContain('812 detections');
  });
});
