import { describe, expect, it } from 'vitest';

import { ProjectPage } from './views/pages.js';
import type { ProjectView } from './views/pages.js';

/**
 * Identifying an athlete is the only step scoring cannot proceed without, and
 * the panel offering it was open exactly when it was no longer needed: `open`
 * was bound to "an athlete record exists", so the first-time user — the one who
 * had done nothing yet — got a collapsed panel whose only control was hidden
 * behind having already created an athlete. Every run they made was
 * arithmetically incapable of suggesting anything, and nothing said so.
 *
 * These assert the reachability of that panel, not its styling.
 */

const view: ProjectView = {
  project: { id: 'prj_test', name: 'Smoke', sport: 'basketball' } as ProjectView['project'],
  videos: [],
  athletes: [],
  moments: [],
  clips: [],
  jobs: [],
  exports: [],
  flash: {},
};

/** The panel markup only — "Identify your athlete" also appears in the layout's CSS. */
const panelOf = (html: string): string => {
  const anchor = html.indexOf('id="identify-athlete"');
  expect(anchor).toBeGreaterThan(-1);
  return html.slice(anchor - 400, anchor + 900);
};

const render = async (athletes: ProjectView['athletes']): Promise<string> =>
  String(await ProjectPage({ ...view, athletes }));

describe('the identify-your-athlete panel', () => {
  it('is open, and offers a control, for a user who has done nothing yet', async () => {
    const panel = panelOf(await render([]));
    expect(panel).toMatch(/<details class="card" open=/);
    // Bindable without first creating an athlete: `new` creates one server-side.
    expect(panel).toContain('/athletes/new/track');
  });

  it('says why it matters, so a collapsed-by-habit user has a reason to look', async () => {
    expect(panelOf(await render([]))).toContain('required for any suggestions');
  });

  it('stops demanding attention once an athlete is bound to a track', async () => {
    const bound = [
      { id: 'ath_1', name: 'Kid', jerseyNumber: null, isFocal: true, focalTrackId: 'trk_1' },
    ] as unknown as ProjectView['athletes'];
    expect(panelOf(await render(bound))).not.toMatch(/<details class="card" open=/);
  });

  /**
   * An athlete that exists but is bound to nothing is the state that produced
   * zero moments while looking, on screen, like the work had been done.
   */
  it('stays open when an athlete exists but is bound to no track', async () => {
    const unbound = [
      { id: 'ath_1', name: 'Kid', jerseyNumber: null, isFocal: true, focalTrackId: null },
    ] as unknown as ProjectView['athletes'];
    const panel = panelOf(await render(unbound));
    expect(panel).toMatch(/<details class="card" open=/);
    expect(panel).toContain('/athletes/ath_1/track');
  });
});
