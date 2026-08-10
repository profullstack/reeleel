import { describe, expect, it } from 'vitest';

import { ProjectPage } from './views/pages.js';
import type { ProjectView } from './views/pages.js';

/**
 * The page updates itself by fetching its own URL and swapping the regions
 * marked `data-live`. That only works while the islands holding state stay
 * outside them.
 *
 * The job log owns an EventSource; swapping it would drop the analysis feed and
 * silently reconnect. The identify grid holds a selection the user is part-way
 * through making; swapping it would discard their clicks — which is close to
 * the original bug, where reloads raced clicks into seven duplicate athletes.
 *
 * `#moment-review` is the exception: it is inside `data-live="moments"` on
 * purpose, because it re-reads everything from a `data-moments` attribute, and
 * live.ts re-mounts it after a swap.
 */

const view: ProjectView = {
  project: { id: 'prj_test', name: 'Smoke', sport: 'basketball' } as ProjectView['project'],
  videos: [],
  athletes: [],
  moments: [],
  clips: [],
  jobs: [],
  exports: [],
  music: [],
  flash: {},
};

const render = async (extra: Partial<ProjectView> = {}): Promise<string> =>
  String(await ProjectPage({ ...view, ...extra }));

/** Crude but sufficient: is `needle` inside a `data-live` block in `html`? */
const insideLiveRegion = (html: string, needle: string): boolean => {
  const at = html.indexOf(needle);
  if (at < 0) return false;
  const before = html.slice(0, at);
  const opens = (before.match(/<div data-live=/g) ?? []).length;
  // Count only the closing tags that belong to a region we have opened.
  let depth = 0;
  let closed = 0;
  for (const match of before.matchAll(/<div data-live=|<div|<\/div>/g)) {
    if (match[0] === '<div data-live=') depth += 1;
    else if (match[0] === '<div' && depth > 0) depth += 1;
    else if (match[0] === '</div>' && depth > 0) {
      depth -= 1;
      if (depth === 0) closed += 1;
    }
  }
  return opens > closed;
};

describe('the regions the page swaps in place', () => {
  it('marks the ones that go stale after a job', async () => {
    const html = await render();
    for (const key of ['videos', 'athletes', 'moments']) {
      expect(html).toContain(`data-live="${key}"`);
    }
  });

  it('keeps the job log outside them, so the analysis feed survives', async () => {
    // An EventSource inside a swapped region is dropped and reconnected on
    // every update, losing the log the user is reading.
    const html = await render({ jobs: [] });
    expect(html).toContain('id="job-log"');
    expect(insideLiveRegion(html, 'id="job-log"')).toBe(false);
  });

  it('keeps the identify grid outside them, so a half-made selection survives', async () => {
    const html = await render();
    expect(html).toContain('id="identify-athlete"');
    expect(insideLiveRegion(html, 'id="identify-athlete"')).toBe(false);
  });

  it('keeps the uploader outside them, so an upload in flight is not interrupted', async () => {
    const html = await render();
    const at = html.indexOf('id="uploads"');
    if (at >= 0) expect(insideLiveRegion(html, 'id="uploads"')).toBe(false);
  });

  it('stops telling a user to refresh once the page can update itself', async () => {
    const running = [
      { id: 'job_x', kind: 'detection', status: 'running', progress: 0.5 },
    ] as unknown as ProjectView['jobs'];
    const html = await render({ jobs: running });
    // Still present for the no-JavaScript case, but hidden once the bundle runs.
    expect(html).toContain('no-js-only');
    const at = html.indexOf('Analysis is running');
    expect(html.slice(Math.max(0, at - 200), at)).toContain('no-js-only');
  });
});
