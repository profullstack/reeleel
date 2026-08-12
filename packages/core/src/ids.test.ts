import { describe, expect, it } from 'vitest';

import { newId, slugify } from './ids.js';

describe('newId', () => {
  it('keeps the prefix and carries 64 bits after it', () => {
    expect(newId('trk')).toMatch(/^trk_[0-9a-f]{16}$/);
    expect(newId('prj')).toMatch(/^prj_[0-9a-f]{16}$/);
  });

  /**
   * The regression. Detection writes one row per track, and production videos
   * reach five figures on their own — the run that prompted this died on
   * "UNIQUE constraint failed: tracks.id" while building a reel from clips,
   * because clips accumulate: re-analysis clears the tracks of one video, not
   * of the project.
   *
   * 200k ids is the smallest sweep that fails the old 32-bit scheme reliably
   * (≈4.7 duplicates expected, so it passed less than one time in a hundred)
   * and that the current one cannot fail by chance (≈1e-9).
   */
  it('does not repeat itself across a project-sized run of tracks', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200_000; i += 1) seen.add(newId('trk'));
    expect(seen.size).toBe(200_000);
  });
});

describe('slugify', () => {
  it('strips diacritics rather than splitting on them', () => {
    expect(slugify('José')).toBe('jose');
  });

  it('falls back when nothing survives', () => {
    expect(slugify('///')).toBe('project');
  });
});
