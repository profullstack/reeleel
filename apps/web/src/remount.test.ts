import { describe, expect, it } from 'vitest';

import { REMOUNT } from './client/live.js';
import { mountMoments } from './client/moments.js';
import { mountReview } from './client/review.js';

/**
 * A swapped region has to be re-hydrated by the island that actually lives in
 * it.
 *
 * `data-live="moments"` contains `#moment-review`, the interactive Keep/Reject
 * list. The map pointed instead at the review scrubber, which lives on a
 * different page and inside no live region at all — so after a refresh the
 * moment list stayed as the server rendered it, with nothing behind its
 * buttons, while the scrubber was re-attached to a node that already had a
 * canvas and a set of controls on it.
 *
 * Both halves are silent failures: the buttons render perfectly and do nothing,
 * and the duplicate scrubber only appears once something has refreshed. Neither
 * is visible in a type or a screenshot, so the wiring is asserted here.
 */

describe('re-mounting after a live region swap', () => {
  it('hydrates the moment list with the moment island', () => {
    expect(REMOUNT['moments']).toBe(mountMoments);
  });

  it('never re-mounts the review scrubber, which is on another page', () => {
    expect(Object.values(REMOUNT)).not.toContain(mountReview);
  });

  it('names only regions the pages actually mark as live', async () => {
    const { ProjectPage } = await import('./views/pages.js');
    const view = {
      project: { id: 'prj_test', name: 'Smoke', sport: 'basketball' },
      videos: [],
      athletes: [],
      moments: [],
      clips: [],
      jobs: [],
      exports: [],
      music: [],
      flash: {},
    } as unknown as Parameters<typeof ProjectPage>[0];
    const html = String(await ProjectPage(view));

    // A key with no matching region is a re-mount that can never fire.
    for (const key of Object.keys(REMOUNT)) {
      expect(html).toContain(`data-live="${key}"`);
    }
  });
});
