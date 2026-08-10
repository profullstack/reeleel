import { describe, expect, it } from 'vitest';

import { ProjectPage } from './views/pages.js';
import type { ProjectView } from './views/pages.js';

/**
 * A suggested moment could not be watched. Judging one meant keeping it,
 * building clips, exporting and downloading a reel — minutes, for a question
 * you have to ask of every suggestion.
 *
 * The player is a plain `<video>` with a media fragment, which needs two things
 * to be true or it silently misbehaves: `#t=start,end` must carry the real
 * span, and `preload="none"` must keep a page of suggestions from fetching a
 * video per moment.
 */

const moment = (over: Partial<ProjectView['moments'][number]>) =>
  ({
    id: 'mom_1',
    projectId: 'prj_1',
    videoId: 'vid_1',
    athleteId: null,
    start: 136.2,
    end: 141.7,
    score: 0.55,
    reasons: ['player_ball_proximity'],
    included: null,
    favorite: false,
    manual: false,
    title: null,
    createdAt: '',
    updatedAt: '',
    ...over,
  }) as ProjectView['moments'][number];

const render = async (moments: ProjectView['moments']): Promise<string> =>
  String(
    await ProjectPage({
      project: { id: 'prj_1', name: 'Game', sport: 'basketball' } as ProjectView['project'],
      videos: [],
      athletes: [],
      moments,
      clips: [],
      jobs: [],
      exports: [],
      music: [],
      flash: {},
    }),
  );

describe('watching a suggested moment', () => {
  it('plays exactly the suggested span', async () => {
    const html = await render([moment({})]);
    expect(html).toContain('/projects/prj_1/videos/vid_1/stream#t=136.20,141.70');
  });

  /**
   * Twice now something necessary has been folded into a <details> and gone
   * unnoticed for hours — the identify panel, then this. An unwatched player
   * already costs nothing, so there is no reason to hide it.
   */
  it('is visible without being unfolded first', async () => {
    const html = await render([moment({})]);
    const anchor = html.indexOf('class="moment-player"');
    expect(anchor).toBeGreaterThan(-1);
    expect(html.slice(anchor - 200, anchor)).not.toContain('<details');
  });

  it('gives the overlay what it needs to draw the right window', async () => {
    const html = await render([moment({})]);
    expect(html).toContain('data-video="/projects/prj_1/videos/vid_1/tracks"');
    expect(html).toContain('data-start="136.2"');
    expect(html).toContain('data-end="141.7"');
  });

  it('fetches nothing until the moment is opened', async () => {
    // Four suggestions must not mean four video downloads on page load.
    const html = await render([moment({}), moment({ id: 'mom_2' })]);
    expect(html.match(/preload="none"/g)).toHaveLength(2);
  });

  it('offers no player for a moment with no footage behind it', async () => {
    const html = await render([moment({ videoId: null })]);
    expect(html).not.toContain('/stream#t=');
  });

  it('still shows keep and reject, which work without JavaScript', async () => {
    const html = await render([moment({})]);
    expect(html).toContain('/projects/prj_1/moments/mom_1/decide');
    expect(html).toContain('Reject');
  });
});
