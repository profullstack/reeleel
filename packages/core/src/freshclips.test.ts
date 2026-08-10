import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Clips generated from suggested moments are derived data, and should be
 * replaced whenever the moments are — which is on every scoring run.
 *
 * They were not, and could not be. `clips.moment_id` is ON DELETE SET NULL and
 * re-scoring deletes every non-manual moment before regenerating, so the id
 * that "have I already made this clip?" matched on was nulled out from under
 * it. Every run appended another copy. A real project reached sixteen clips
 * against one moment, three of them the same five seconds.
 */

let home: string;

beforeAll(() => {
  home = mkdtempSync(path.join(tmpdir(), 'reeleel-clips-'));
  process.env['REELEEL_HOME'] = home;
});

afterAll(async () => {
  const { resetDbCache } = await import('./db.js');
  resetDbCache();
  rmSync(home, { recursive: true, force: true });
  delete process.env['REELEEL_HOME'];
});

const project = async (name: string): Promise<string> => {
  const { createProject } = await import('./projects.js');
  const created = await createProject({
    name,
    path: path.join(home, 'projects', `${name}-${process.hrtime.bigint()}`),
  });
  return created.root;
};

const keptMoment = async (root: string, start: number) => {
  const { addMoment, updateMoment } = await import('./moments.js');
  const moment = await addMoment(root, {
    start,
    end: start + 5,
    score: 0.5,
    reasons: [],
    videoId: null,
    manual: false,
    included: true,
  });
  await updateMoment(root, moment.id, { included: true });
  return moment;
};

describe('generating clips from moments', () => {
  it('does not pile up another copy every time it runs', async () => {
    const root = await project('repeat');
    const { clipsFromMoments, listClips } = await import('./clips.js');
    await keptMoment(root, 10);

    await clipsFromMoments(root);
    await clipsFromMoments(root);
    await clipsFromMoments(root);

    // Three runs, one moment, one clip — not three.
    expect(await listClips(root)).toHaveLength(1);
  });

  /** The case that actually bit: the moment is gone, so the link is null. */
  it('replaces a clip whose moment has since been regenerated', async () => {
    const root = await project('regenerated');
    const { clipsFromMoments, listClips } = await import('./clips.js');
    const { removeMoment } = await import('./moments.js');

    const first = await keptMoment(root, 20);
    await clipsFromMoments(root);
    // Re-scoring deletes the moment; the clip's moment_id becomes NULL.
    await removeMoment(root, first.id);
    await keptMoment(root, 20);
    await clipsFromMoments(root);

    const clips = await listClips(root);
    expect(clips).toHaveLength(1);
    expect(clips[0]!.start).toBe(20);
  });

  it('leaves a clip the user made alone', async () => {
    const root = await project('manual');
    const { addClip, clipsFromMoments, listClips } = await import('./clips.js');

    const mine = await addClip(root, { start: 100, end: 105, manual: true });
    await keptMoment(root, 30);
    await clipsFromMoments(root);
    await clipsFromMoments(root);

    const clips = await listClips(root);
    expect(clips.map((clip) => clip.id)).toContain(mine.id);
    // The manual one plus exactly one generated one.
    expect(clips).toHaveLength(2);
    expect(clips.find((clip) => clip.id === mine.id)?.manual).toBe(true);
  });

  it('drops generated clips when their moment is rejected', async () => {
    const root = await project('rejected');
    const { clipsFromMoments, listClips } = await import('./clips.js');
    const { updateMoment } = await import('./moments.js');

    const moment = await keptMoment(root, 40);
    await clipsFromMoments(root);
    expect(await listClips(root)).toHaveLength(1);

    await updateMoment(root, moment.id, { included: false });
    await clipsFromMoments(root);
    // Rejecting a moment must not leave its clip in the reel.
    expect(await listClips(root)).toHaveLength(0);
  });
});
