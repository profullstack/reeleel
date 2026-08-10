import { describe, expect, it } from 'vitest';

import { fadeFilters } from './render.js';

/**
 * Every clip came out pure black the moment fades were added, and the reel with
 * background music was a black screen with audio over it.
 *
 * `-ss` was an *output* option, which runs after the filter graph: FFmpeg
 * filtered the whole video from 0:00 and only then discarded everything before
 * the clip. So a clip starting at 2:16 handed its filters frames stamped t≈136,
 * far past `fade=t=out:st=4.65`, and the fade-out had already completed on
 * every surviving frame. Measured YAVG 16 (pure black) against 123 for the same
 * frame with the fade removed.
 *
 * Two things had to be true and neither was:
 *
 *   1. the seek must happen on the input, so the graph only ever sees the clip
 *   2. timestamps must start at zero, because the crop path is rebased by
 *      clip.start and the fades are written against the clip's own length
 *
 * The crop was being evaluated at the wrong instant for the same reason, which
 * nothing caught because a wrong crop still looks like a picture.
 */

describe('a fade is written against the clip, not the source timeline', () => {
  it('schedules the fade-out inside the clip', () => {
    const { video } = fadeFilters(5, 0.35);
    const out = /fade=t=out:st=([\d.]+)/.exec(video);
    expect(out).not.toBeNull();
    const start = Number(out![1]);
    // 4.65, not 140.65: the filter must never be handed source-relative time.
    expect(start).toBeGreaterThan(0);
    expect(start).toBeLessThan(5);
  });

  it('starts the fade-in at zero, which is only correct for a rebased clock', () => {
    expect(fadeFilters(5, 0.35).video).toContain('fade=t=in:st=0');
    expect(fadeFilters(5, 0.35).audio).toContain('afade=t=in:st=0');
  });

  /**
   * The property that actually failed: a frame in the middle of the clip must
   * fall between the two fades. It did not, because `t` there was 138.5.
   */
  it('leaves the middle of the clip untouched by either fade', () => {
    const duration = 5;
    const fade = 0.35;
    const { video } = fadeFilters(duration, fade);
    const outStart = Number(/fade=t=out:st=([\d.]+)/.exec(video)![1]);
    const middle = duration / 2;
    expect(middle).toBeGreaterThan(fade);
    expect(middle).toBeLessThan(outStart);
  });

  it('keeps the fades inside even a very short clip', () => {
    const duration = 1.2;
    const { video } = fadeFilters(duration);
    const outStart = Number(/fade=t=out:st=([\d.]+)/.exec(video)![1]);
    const d = Number(/fade=t=out:st=[\d.]+:d=([\d.]+)/.exec(video)![1]);
    expect(outStart + d).toBeLessThanOrEqual(duration + 0.001);
  });
});
