import { describe, expect, it } from 'vitest';

import { ReviewPage } from './views/review.js';
import type { ProjectSummary, SourceVideo } from '@reeleel/core';

/**
 * Identification was a grid of the *longest* tracks. On footage that fragments
 * into thousands of them the longest belong to a coach, the referee, and
 * whoever stood still longest — so the picker offered a page of strangers and
 * no way to say "not those, him". Reported as "just random kids", which is
 * precisely what it was.
 *
 * Pointing at the child on screen cannot be misread. These assert the surface
 * carries what the island needs to draw and to bind, because a missing data
 * attribute fails silently: the video plays, no boxes appear, and nothing says
 * why.
 */

const project = { id: 'prj_1', name: 'Game', sport: 'basketball' } as ProjectSummary;
const video = { id: 'vid_1', probe: { durationSeconds: 300 } } as SourceVideo;

const render = async (over: Partial<Parameters<typeof ReviewPage>[0]> = {}): Promise<string> =>
  String(
    await ReviewPage({
      project,
      video,
      athleteName: null,
      trackCount: 3755,
      flash: {},
      ...over,
    }),
  );

describe('the review surface', () => {
  it('points the island at the track feed and the bind endpoint', async () => {
    const html = await render();
    expect(html).toContain('data-tracks="/projects/prj_1/videos/vid_1/tracks"');
    // `new` so a first-time user needs no prior setup to identify anyone.
    expect(html).toContain('data-bind="/projects/prj_1/athletes/new/track"');
  });

  it('streams the footage rather than embedding a rendered debug copy', async () => {
    expect(await render()).toContain('/projects/prj_1/videos/vid_1/stream');
  });

  it('says how many tracks there are, and whether anyone is being followed', async () => {
    expect(await render()).toContain('no athlete identified');
    expect(await render({ athleteName: 'Sam' })).toContain('following Sam');
    expect(await render()).toContain('3755');
  });

  it('says so plainly when there is no footage, instead of an empty player', async () => {
    const html = await render({ video: undefined });
    expect(html).toContain('No footage imported yet');
    expect(html).not.toContain('data-tracks=');
  });
});
