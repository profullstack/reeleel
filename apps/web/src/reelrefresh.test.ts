import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Export should render the moments you have, not the ones you had.
 *
 * `createReel` defaults its clip list to whatever exists the moment it is
 * called, and `reel_clips` is fixed membership from then on. The export action
 * created the reel inside a try, swallowed the CONFLICT on every later export,
 * and so re-rendered the snapshot it took the first time. Production shows it
 * exactly: a reel pinned to four clips chosen on its first render, then
 * rendered unchanged for the next five exports across two days and several
 * detection runs. No moment found afterwards could ever reach it.
 *
 * Accepting a moment also does not, by itself, produce a clip — that lived
 * behind a separate action — so the new moments were not even candidates.
 */

let home: string;
let root: string;
let app: Hono;

beforeAll(async () => {
  home = mkdtempSync(path.join(tmpdir(), 'reeleel-reelrefresh-'));
  process.env['REELEEL_HOME'] = home;

  const { createProject } = await import('@reeleel/core');
  const created = await createProject({
    name: 'reelrefresh',
    path: path.join(home, 'projects', 'reelrefresh'),
    sport: 'basketball',
  });
  root = created.path ?? created.root;

  const { registerActions } = await import('./actions.js');
  app = new Hono();
  registerActions(app);
});

beforeEach(() => {
  // The render itself is fired off detached and cannot succeed against a
  // fixture with no video behind it; its complaints are not this test's subject.
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterAll(async () => {
  vi.restoreAllMocks();
  const { resetDbCache } = await import('@reeleel/core');
  resetDbCache();
  rmSync(home, { recursive: true, force: true });
  delete process.env['REELEEL_HOME'];
});

/** A moment the user has kept, which is what an export is supposed to contain. */
const keep = async (start: number): Promise<void> => {
  const { addMoment } = await import('@reeleel/core');
  await addMoment(root, {
    start,
    end: start + 5,
    score: 0.5,
    reasons: ['high_motion'],
    videoId: null,
    manual: false,
    included: true,
  });
};

const exportReel = async (): Promise<Response> =>
  app.request(`/projects/${encodeURIComponent(root)}/export`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ name: 'highlights', aspect: '16:9' }).toString(),
  });

const reelSpans = async (): Promise<{ start: number; end: number }[]> => {
  const { getReel, listClips } = await import('@reeleel/core');
  const reel = await getReel(root, 'highlights');
  const byId = new Map((await listClips(root)).map((clip) => [clip.id, clip]));
  return reel.clipIds
    .flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []))
    .map((clip) => ({ start: clip.start, end: clip.end }))
    .sort((a, b) => a.start - b.start);
};

describe('exporting a reel', () => {
  it('turns the kept moments into clips without a separate step', async () => {
    await keep(10);
    await exportReel();

    expect(await reelSpans()).toEqual([{ start: 10, end: 15 }]);
  });

  it('picks up moments found after the reel was first created', async () => {
    // The regression. The reel already exists from the test above, so this is
    // the export that used to hit CONFLICT and silently re-render the old list.
    await keep(120);
    await exportReel();

    expect(await reelSpans()).toEqual([
      { start: 10, end: 15 },
      { start: 120, end: 125 },
    ]);
  });

  it('keeps clips the user made by hand, alongside the generated ones', async () => {
    const { addClip } = await import('@reeleel/core');
    await addClip(root, { start: 300, end: 305, videoId: null, manual: true });

    await exportReel();

    const spans = await reelSpans();
    expect(spans).toContainEqual({ start: 300, end: 305 });
    // And the derived ones are still there, not replaced by the manual clip.
    expect(spans).toContainEqual({ start: 120, end: 125 });
  });

  /**
   * Pointing the reel at "every clip" is only an improvement if the project's
   * history cannot put the same footage in it repeatedly — and this one's can.
   * Generated clips piled up on every scoring run until that was fixed, and the
   * copies already made were marked manual, so they survived on purpose.
   * Production still holds 17 clip rows for 7 distinct spans, five in
   * triplicate: rendering all of them would repeat five clips three times each.
   */
  it('plays the same seconds once, however many rows the project holds', async () => {
    const { addClip } = await import('@reeleel/core');
    for (let i = 0; i < 3; i += 1) {
      await addClip(root, { start: 136, end: 141, videoId: null, manual: true });
    }

    await exportReel();

    const spans = await reelSpans();
    expect(spans.filter((s) => s.start === 136)).toHaveLength(1);
    // And distinct footage is still distinct — this must not collapse the reel.
    expect(spans.filter((s) => s.start === 300)).toHaveLength(1);
  });

  it('drops a moment the user rejected on the next export', async () => {
    const { listMoments, updateMoment } = await import('@reeleel/core');
    const moment = (await listMoments(root)).find((m) => m.start === 120);
    await updateMoment(root, moment!.id, { included: false });

    await exportReel();

    const spans = await reelSpans();
    expect(spans).not.toContainEqual({ start: 120, end: 125 });
    expect(spans).toContainEqual({ start: 10, end: 15 });
  });
});
