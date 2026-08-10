import { describe, expect, it } from 'vitest';

import { DEFAULT_FADE_SECONDS, DEFAULT_MUSIC_VOLUME, fadeFilters } from './render.js';

/**
 * A reel that cuts dead between plays reads as broken rather than edited, and
 * the audio cut is the worse half: a crowd at full volume stopping mid-syllable
 * sounds like a corrupt file.
 *
 * The arithmetic is what matters here. FFmpeg does not validate these strings
 * against the clip — a fade-out scheduled past the end simply never happens,
 * silently, and a negative start is accepted and ignored.
 */

describe('fadeFilters', () => {
  it('fades in from zero and out to land exactly on the end', () => {
    const { video, audio } = fadeFilters(10, 0.35);
    expect(video).toBe('fade=t=in:st=0:d=0.350,fade=t=out:st=9.650:d=0.350');
    expect(audio).toBe('afade=t=in:st=0:d=0.350,afade=t=out:st=9.650:d=0.350');
  });

  /** Otherwise a two-second moment would be more fade than footage. */
  it('never spends more than a third of a short clip fading', () => {
    const { video } = fadeFilters(0.6, 0.35);
    expect(video).toContain('d=0.200');
    expect(video).toContain('st=0.400');
  });

  it('produces nothing at all when fading is turned off', () => {
    // An empty -af is an FFmpeg error, not a no-op, so this must be empty
    // rather than a filter that happens to do nothing.
    expect(fadeFilters(10, 0)).toEqual({ video: '', audio: '' });
  });

  it('refuses a clip of unknown or impossible length instead of emitting NaN', () => {
    expect(fadeFilters(Number.NaN)).toEqual({ video: '', audio: '' });
    expect(fadeFilters(0)).toEqual({ video: '', audio: '' });
    expect(fadeFilters(-5)).toEqual({ video: '', audio: '' });
  });

  it('defaults to a fade you read as an edit, not a transition', () => {
    expect(DEFAULT_FADE_SECONDS).toBeGreaterThan(0);
    expect(DEFAULT_FADE_SECONDS).toBeLessThan(1);
    expect(fadeFilters(10)).toEqual(fadeFilters(10, DEFAULT_FADE_SECONDS));
  });
});

describe('music level', () => {
  /**
   * The crowd, the shoes and a parent shouting are most of why the clip is
   * worth keeping. Music that competes with them makes the reel worse.
   */
  it('sits well under the game audio', () => {
    expect(DEFAULT_MUSIC_VOLUME).toBeGreaterThan(0);
    expect(DEFAULT_MUSIC_VOLUME).toBeLessThan(0.35);
  });
});
