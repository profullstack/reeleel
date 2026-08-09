import { describe, expect, it } from 'vitest';

import { thumbnailIndexFor, thumbnailPath } from './candidates.js';

/**
 * The gap this closes: `updateAthlete` accepted a `focalTrackId` and no surface
 * ever passed one. "Follow" set `is_focal` and left the track null, and scoring
 * reads the track, not the flag — so every run was capped at 0.087 against a
 * 0.35 threshold however good the detection was.
 *
 * Picking a track means showing frames, which means mapping a timestamp onto
 * the thumbnails generateThumbnails wrote.
 */

describe('thumbnailIndexFor', () => {
  // generateThumbnails writes `count` frames across the whole duration.
  const COUNT = 60;

  it('is 1-based, because ffmpeg %05d starts at one', () => {
    expect(thumbnailIndexFor(0, 600, COUNT)).toBe(1);
  });

  it('lands in the right slot across the video', () => {
    // 600s over 60 frames is one frame per 10s.
    expect(thumbnailIndexFor(10, 600, COUNT)).toBe(2);
    expect(thumbnailIndexFor(19.9, 600, COUNT)).toBe(2);
    expect(thumbnailIndexFor(20, 600, COUNT)).toBe(3);
    expect(thumbnailIndexFor(300, 600, COUNT)).toBe(31);
  });

  it('never runs past the last frame that exists', () => {
    // The final timestamp must not ask for thumb_00061.
    expect(thumbnailIndexFor(600, 600, COUNT)).toBe(COUNT);
    expect(thumbnailIndexFor(900, 600, COUNT)).toBe(COUNT);
  });

  it('never returns zero or negative for a nonsense timestamp', () => {
    expect(thumbnailIndexFor(-5, 600, COUNT)).toBe(1);
  });

  it('falls back to the first frame when duration is unknown', () => {
    // A zero duration would otherwise divide by zero.
    expect(thumbnailIndexFor(10, 0, COUNT)).toBe(1);
    expect(thumbnailIndexFor(10, 600, 0)).toBe(1);
  });
});

describe('thumbnailPath', () => {
  it('matches the name generateThumbnails writes', () => {
    // ffmpeg pattern: thumb_%05d.jpg
    expect(thumbnailPath('/p', 'vid_abc', 1).endsWith('/thumbnails/vid_abc/thumb_00001.jpg')).toBe(
      true,
    );
    expect(thumbnailPath('/p', 'vid_abc', 42).endsWith('thumb_00042.jpg')).toBe(true);
    expect(thumbnailPath('/p', 'vid_abc', 60).endsWith('thumb_00060.jpg')).toBe(true);
  });
});
