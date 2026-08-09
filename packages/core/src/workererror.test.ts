import { describe, expect, it } from 'vitest';

import { cvWorkerError } from './analyze.js';

/**
 * The regression these guard: the CV worker emits `{"error": "..."}` on stdout
 * and signals failure through its exit code, so stderr is empty. Reading only
 * stderr discarded the explanation, and production logged "The CV worker failed
 * on vid_….mp4." with nothing after it — a job that says `failed` and will not
 * say why.
 */
describe('cvWorkerError', () => {
  it('reads the error the worker put on stdout', () => {
    const stdout = JSON.stringify({
      error:
        'No detection model found for soccer. Download the default one with ' +
        '`reeleel-cv fetch-model --sport soccer`.',
    });
    expect(cvWorkerError(stdout)).toContain('No detection model found for soccer');
  });

  it('takes the last thing the worker managed to say', () => {
    const stdout = [
      JSON.stringify({ progress: 0.5 }),
      JSON.stringify({ error: 'onnxruntime failed to load' }),
    ].join('\n');
    expect(cvWorkerError(stdout)).toBe('onnxruntime failed to load');
  });

  it('ignores trailing blank lines, which a newline-terminated write leaves', () => {
    expect(cvWorkerError(`${JSON.stringify({ error: 'boom' })}\n\n`)).toBe('boom');
  });

  it('returns nothing when the worker died before it could speak', () => {
    expect(cvWorkerError('')).toBeUndefined();
    expect(cvWorkerError('   \n  ')).toBeUndefined();
    // A crash can leave a native stack trace rather than JSON.
    expect(cvWorkerError('Segmentation fault (core dumped)')).toBeUndefined();
  });

  it('ignores well-formed output that carries no error', () => {
    expect(cvWorkerError(JSON.stringify({ detections: [], tracks: [] }))).toBeUndefined();
    expect(cvWorkerError(JSON.stringify({ error: '' }))).toBeUndefined();
    expect(cvWorkerError(JSON.stringify({ error: 42 }))).toBeUndefined();
  });

  it('survives a partially written line, which a killed process leaves behind', () => {
    const stdout = `${JSON.stringify({ error: 'ran out of memory' })}\n{"detections":[`;
    expect(cvWorkerError(stdout)).toBe('ran out of memory');
  });
});
