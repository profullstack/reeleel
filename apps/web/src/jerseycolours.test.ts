import { describe, expect, it } from 'vitest';

import { JERSEY_BINS } from '@reeleel/core';

import { JERSEY_COLOURS } from './client/identify.js';

/**
 * The panel offers colours; the matcher bins them. If those two lists drift, the
 * panel makes a promise nothing keeps — a colour it suggests that the matcher
 * has no bins for is a colour it cannot hold anybody to, and the veto silently
 * does nothing on the one project that most needed it.
 *
 * The client bundle cannot import from `@reeleel/core` — it is browser code and
 * that package reaches a database driver — so the list is duplicated on purpose
 * and guarded here instead.
 */

describe('the shirt colours the panel offers', () => {
  it('are all colours the matcher can measure', () => {
    for (const colour of JERSEY_COLOURS) {
      expect(JERSEY_BINS[colour], `${colour} has no bins`).toBeDefined();
    }
  });

  it('offers white and black, which is the case that prompted all of this', () => {
    expect(JERSEY_COLOURS).toContain('white');
    expect(JERSEY_COLOURS).toContain('black');
  });

  it('has no duplicates', () => {
    expect(new Set(JERSEY_COLOURS).size).toBe(JERSEY_COLOURS.length);
  });
});
