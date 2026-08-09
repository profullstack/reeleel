import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { nextExportPath } from './render.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'reeleel-exports-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const touch = (name: string): void => writeFileSync(path.join(dir, name), 'x');

/**
 * Exports were written to a path derived from the reel name alone, so every
 * re-export silently replaced the previous file. A render is minutes of work
 * and the old one may already have been shared.
 */
describe('nextExportPath', () => {
  it('uses the plain name when nothing is there yet', () => {
    expect(nextExportPath(dir, 'highlights_16x9')).toBe(path.join(dir, 'highlights_16x9.mp4'));
  });

  it('never overwrites an export that already exists', () => {
    touch('highlights_16x9.mp4');
    expect(nextExportPath(dir, 'highlights_16x9')).toBe(path.join(dir, 'highlights_16x9-2.mp4'));
  });

  it('keeps counting past every version already rendered', () => {
    touch('highlights_16x9.mp4');
    touch('highlights_16x9-2.mp4');
    touch('highlights_16x9-3.mp4');
    expect(nextExportPath(dir, 'highlights_16x9')).toBe(path.join(dir, 'highlights_16x9-4.mp4'));
  });

  it('keeps aspect ratios apart, since they are different renders', () => {
    touch('highlights_16x9.mp4');
    expect(nextExportPath(dir, 'highlights_9x16')).toBe(path.join(dir, 'highlights_9x16.mp4'));
  });

  it('is not confused by a similarly-named export', () => {
    touch('highlights_16x9-final.mp4');
    expect(nextExportPath(dir, 'highlights_16x9')).toBe(path.join(dir, 'highlights_16x9.mp4'));
  });
});
