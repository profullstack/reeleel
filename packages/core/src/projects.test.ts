import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

let home: string;

// layout.ts reads REELEEL_HOME on every call, so pointing it at a temp dir
// isolates the whole test run from the developer's real projects and registry.
beforeAll(() => {
  home = mkdtempSync(path.join(tmpdir(), 'reeleel-test-'));
  process.env['REELEEL_HOME'] = home;
});

afterAll(async () => {
  const { resetDbCache } = await import('./db.js');
  resetDbCache();
  rmSync(home, { recursive: true, force: true });
  delete process.env['REELEEL_HOME'];
});

const freshProject = async (name = 'Test Game') => {
  const { createProject } = await import('./projects.js');
  return createProject({ name, path: path.join(home, 'projects', `${name}-${Date.now()}-${Math.random()}`) });
};

describe('project lifecycle', () => {
  beforeEach(async () => {
    const { resetDbCache } = await import('./db.js');
    resetDbCache();
  });

  it('creates the portable directory layout the PRD specifies', async () => {
    const { PROJECT_DIRS, manifestPath, databasePath } = await import('./layout.js');
    const { root } = await freshProject('Layout Game');

    for (const dir of PROJECT_DIRS) expect(existsSync(path.join(root, dir))).toBe(true);
    expect(existsSync(manifestPath(root))).toBe(true);
    expect(existsSync(databasePath(root))).toBe(true);
  });

  it('registers the project so it can be found by id and by name', async () => {
    const { resolveProjectRoot } = await import('./projects.js');
    const { root, manifest } = await freshProject('Findable Game');

    expect(await resolveProjectRoot(manifest.id)).toBe(root);
    expect(await resolveProjectRoot('Findable Game')).toBe(root);
    expect(await resolveProjectRoot(root)).toBe(root);
  });

  it('refuses to create a second project in the same directory', async () => {
    const { createProject } = await import('./projects.js');
    const { root } = await freshProject('Duplicate Game');
    await expect(createProject({ name: 'Another', path: root })).rejects.toThrow(/already contains/);
  });

  it('rejects an unknown sport', async () => {
    const { createProject } = await import('./projects.js');
    await expect(
      createProject({ name: 'Quidditch', sport: 'quidditch', path: path.join(home, 'q') }),
    ).rejects.toThrow(/not a supported sport/);
  });

  it('updates metadata and clears optional fields with null', async () => {
    const { updateProject, readManifest } = await import('./projects.js');
    const { root } = await freshProject('Editable Game');

    await updateProject(root, { opponent: 'Rovers', description: 'Quarter final' });
    expect(readManifest(root).opponent).toBe('Rovers');

    await updateProject(root, { opponent: null });
    expect(readManifest(root).opponent).toBeUndefined();
    // Clearing one field must not disturb another.
    expect(readManifest(root).description).toBe('Quarter final');
  });

  it('unregisters without deleting files by default', async () => {
    const { removeProject, listProjects } = await import('./projects.js');
    const { root, manifest } = await freshProject('Keep Files Game');

    await removeProject(root);
    expect(existsSync(root)).toBe(true);
    expect((await listProjects()).some((p) => p.id === manifest.id)).toBe(false);
  });

  it('deletes files only when explicitly asked', async () => {
    const { removeProject } = await import('./projects.js');
    const { root } = await freshProject('Delete Me Game');

    await removeProject(root, { deleteFiles: true });
    expect(existsSync(root)).toBe(false);
  });

  it('refuses to delete a directory that is not a ReelEel project', async () => {
    const { removeProject } = await import('./projects.js');
    const notAProject = mkdtempSync(path.join(home, 'plain-'));
    await expect(removeProject(notAProject, { deleteFiles: true })).rejects.toThrow(
      /does not look like a ReelEel project/,
    );
    expect(existsSync(notAProject)).toBe(true);
  });

  it('keeps sources and decisions when clearing derived data', async () => {
    const { removeProject } = await import('./projects.js');
    const { manifestPath } = await import('./layout.js');
    const { root } = await freshProject('Clean Game');

    const result = await removeProject(root, { derivedOnly: true });
    expect(result.unregistered).toBe(false);
    expect(existsSync(manifestPath(root))).toBe(true);
    expect(existsSync(path.join(root, 'proxies'))).toBe(true);
  });
});

describe('athletes', () => {
  beforeEach(async () => {
    const { resetDbCache } = await import('./db.js');
    resetDbCache();
  });

  it('makes the first athlete focal automatically', async () => {
    const { addAthlete, getFocalAthlete } = await import('./athletes.js');
    const { root } = await freshProject('Athlete Game');

    const first = await addAthlete(root, { name: 'Sam', jerseyNumber: '7' });
    expect(first.isFocal).toBe(true);
    expect((await getFocalAthlete(root))?.id).toBe(first.id);
  });

  it('moves focus to exactly one athlete at a time', async () => {
    const { addAthlete, listAthletes, updateAthlete } = await import('./athletes.js');
    const { root } = await freshProject('Focus Game');

    const first = await addAthlete(root, { name: 'Sam' });
    const second = await addAthlete(root, { name: 'Alex' });
    expect(second.isFocal).toBe(false);

    await updateAthlete(root, second.id, { focal: true });
    const all = await listAthletes(root);
    expect(all.filter((a) => a.isFocal)).toHaveLength(1);
    expect(all.find((a) => a.isFocal)?.id).toBe(second.id);
    expect(all.find((a) => a.id === first.id)?.isFocal).toBe(false);
  });

  it('promotes a remaining athlete when the focal one is removed', async () => {
    const { addAthlete, getFocalAthlete, removeAthlete } = await import('./athletes.js');
    const { root } = await freshProject('Promote Game');

    const first = await addAthlete(root, { name: 'Sam' });
    await addAthlete(root, { name: 'Alex' });

    await removeAthlete(root, first.id);
    const focal = await getFocalAthlete(root);
    expect(focal).not.toBeNull();
    expect(focal?.name).toBe('Alex');
  });

  it('finds an athlete by jersey number', async () => {
    const { addAthlete, getAthlete } = await import('./athletes.js');
    const { root } = await freshProject('Jersey Game');

    await addAthlete(root, { name: 'Sam', jerseyNumber: '7' });
    expect((await getAthlete(root, '7')).name).toBe('Sam');
  });
});

describe('moments and clips', () => {
  beforeEach(async () => {
    const { resetDbCache } = await import('./db.js');
    resetDbCache();
  });

  it('records a manual moment as kept and manual', async () => {
    const { addMoment } = await import('./moments.js');
    const { root } = await freshProject('Moment Game');

    const moment = await addMoment(root, { start: 10, end: 20, included: true });
    expect(moment.manual).toBe(true);
    expect(moment.included).toBe(true);
    expect(moment.reasons).toEqual(['user_marker']);
  });

  it('rejects a moment that ends before it starts', async () => {
    const { addMoment } = await import('./moments.js');
    const { root } = await freshProject('Bad Moment Game');
    await expect(addMoment(root, { start: 20, end: 10 })).rejects.toThrow(/after its start/);
  });

  it('supports the undecided / keep / reject tri-state', async () => {
    const { addMoment, updateMoment } = await import('./moments.js');
    const { root } = await freshProject('Tristate Game');

    const moment = await addMoment(root, { start: 5, end: 15, included: null });
    expect(moment.included).toBeNull();

    expect((await updateMoment(root, moment.id, { included: true })).included).toBe(true);
    expect((await updateMoment(root, moment.id, { included: false })).included).toBe(false);
    expect((await updateMoment(root, moment.id, { included: null })).included).toBeNull();
  });

  it('only promotes kept moments to clips', async () => {
    const { addMoment } = await import('./moments.js');
    const { clipsFromMoments } = await import('./clips.js');
    const { root } = await freshProject('Promote Clips Game');

    await addMoment(root, { start: 10, end: 20, included: true });
    await addMoment(root, { start: 30, end: 40, included: false });
    await addMoment(root, { start: 50, end: 60, included: null });

    const clips = await clipsFromMoments(root);
    expect(clips).toHaveLength(1);
    expect(clips[0]?.start).toBe(10);
  });

  it('does not duplicate clips when run twice', async () => {
    const { addMoment } = await import('./moments.js');
    const { clipsFromMoments, listClips } = await import('./clips.js');
    const { root } = await freshProject('Idempotent Clips Game');

    await addMoment(root, { start: 10, end: 20, included: true });
    await clipsFromMoments(root);
    await clipsFromMoments(root);
    expect(await listClips(root)).toHaveLength(1);
  });

  it('invalidates a render when a clip is trimmed', async () => {
    const { addClip, updateClip } = await import('./clips.js');
    const { root } = await freshProject('Trim Game');

    const clip = await addClip(root, { start: 10, end: 20 });
    await updateClip(root, clip.id, { renderedPath: '/tmp/fake.mp4' });
    const trimmed = await updateClip(root, clip.id, { end: 18 });
    expect(trimmed.renderedPath).toBeNull();
  });

  it('reorders clips and keeps unlisted ones after the named ones', async () => {
    const { addClip, reorderClips } = await import('./clips.js');
    const { root } = await freshProject('Reorder Game');

    const a = await addClip(root, { start: 0, end: 5 });
    const b = await addClip(root, { start: 10, end: 15 });
    const c = await addClip(root, { start: 20, end: 25 });

    const ordered = await reorderClips(root, [c.id, a.id]);
    expect(ordered.map((clip) => clip.id)).toEqual([c.id, a.id, b.id]);
  });
});

describe('reels', () => {
  beforeEach(async () => {
    const { resetDbCache } = await import('./db.js');
    resetDbCache();
  });

  it('defaults to every clip, in timeline order', async () => {
    const { addClip } = await import('./clips.js');
    const { createReel } = await import('./reels.js');
    const { root } = await freshProject('Reel Game');

    const a = await addClip(root, { start: 0, end: 5 });
    const b = await addClip(root, { start: 10, end: 15 });

    const reel = await createReel(root, { name: 'highlights' });
    expect(reel.clipIds).toEqual([a.id, b.id]);
    expect(reel.aspect).toBe('16:9');
  });

  it('rejects a duplicate reel name', async () => {
    const { createReel } = await import('./reels.js');
    const { root } = await freshProject('Duplicate Reel Game');

    await createReel(root, { name: 'highlights' });
    await expect(createReel(root, { name: 'highlights' })).rejects.toThrow(/already exists/);
  });

  it('adds and removes clips without deleting them', async () => {
    const { addClip, listClips } = await import('./clips.js');
    const { addClipsToReel, createReel, removeClipsFromReel } = await import('./reels.js');
    const { root } = await freshProject('Reel Membership Game');

    const a = await addClip(root, { start: 0, end: 5 });
    const reel = await createReel(root, { name: 'highlights', clipIds: [] });

    expect((await addClipsToReel(root, reel.id, [a.id])).clipIds).toEqual([a.id]);
    expect((await removeClipsFromReel(root, reel.id, [a.id])).clipIds).toEqual([]);
    expect(await listClips(root)).toHaveLength(1);
  });
});

describe('jobs', () => {
  beforeEach(async () => {
    const { resetDbCache } = await import('./db.js');
    resetDbCache();
  });

  it('records lifecycle transitions and timestamps', async () => {
    const { createJob, updateJob } = await import('./jobs.js');
    const { root } = await freshProject('Job Game');

    const job = await createJob(root, 'detection', { preset: 'fast' });
    expect(job.status).toBe('queued');
    expect(job.params['preset']).toBe('fast');

    const running = await updateJob(root, job.id, { status: 'running', stage: 'detection' });
    expect(running.startedAt).not.toBeNull();

    const done = await updateJob(root, job.id, { status: 'completed', progress: 1 });
    expect(done.finishedAt).not.toBeNull();
  });

  it('will not cancel a job that already finished', async () => {
    const { cancelJob, createJob, updateJob } = await import('./jobs.js');
    const { root } = await freshProject('Cancel Game');

    const job = await createJob(root, 'render');
    await updateJob(root, job.id, { status: 'completed' });
    await expect(cancelJob(root, job.id)).rejects.toThrow(/already completed/);
  });

  it('retries a failed job as a new queued job with the same params', async () => {
    const { createJob, retryJob, updateJob } = await import('./jobs.js');
    const { root } = await freshProject('Retry Game');

    const job = await createJob(root, 'proxy', { height: 540 });
    await updateJob(root, job.id, { status: 'failed', error: 'boom' });

    const retried = await retryJob(root, job.id);
    expect(retried.id).not.toBe(job.id);
    expect(retried.status).toBe('queued');
    expect(retried.params['height']).toBe(540);
  });
});
