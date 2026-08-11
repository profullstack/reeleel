import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Failing an interrupted job honestly is only half of it.
 *
 * "Start it again" assumes somebody is watching, and the run this matters for
 * is the hour-long one they walked away from. Production lost a 61-minute
 * upload to a deploy three minutes in, at the proxy stage, having detected
 * nothing. The job failed correctly and said so. The footage then sat
 * unanalysed while every screen kept showing results from a different,
 * five-minute file — which reads, from the outside, as the product not working.
 *
 * The one thing this must never do is feed a crash loop: a run that kills the
 * container resumes, dies and resumes for ever, taking the service with it.
 */

let home: string;

beforeAll(() => {
  home = mkdtempSync(path.join(tmpdir(), 'reeleel-resume-'));
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

/** A detection job that a restart caught mid-flight. */
const interrupted = async (root: string, params: Record<string, unknown>): Promise<string> => {
  const { createJob, updateJob } = await import('./jobs.js');
  const job = await createJob(root, 'detection', params);
  await updateJob(root, job.id, { status: 'running', stage: 'proxy', progress: 0.1 });
  return job.id;
};

/** One that a restart already caught and the sweep has since failed. */
const alreadyLost = async (root: string): Promise<void> => {
  const { createJob, updateJob, failInterruptedJobs } = await import('./jobs.js');
  const job = await createJob(root, 'detection', {});
  await updateJob(root, job.id, { status: 'running', progress: 0.1 });
  await failInterruptedJobs(root);
};

describe('resuming detection a restart killed', () => {
  it('hands back the run, with the preset and video it was started on', async () => {
    const root = await project('resume');
    const { interruptedDetections } = await import('./jobs.js');

    await interrupted(root, { preset: 'thorough', videoIds: ['vid_a5f10223'] });

    const found = await interruptedDetections(root);
    expect(found).toHaveLength(1);
    expect(found[0]?.params['preset']).toBe('thorough');
    expect(found[0]?.params['videoIds']).toEqual(['vid_a5f10223']);
  });

  it('leaves renders alone — those are seconds, and the user is watching', async () => {
    const root = await project('render-only');
    const { createJob, updateJob, interruptedDetections } = await import('./jobs.js');

    const job = await createJob(root, 'render', {});
    await updateJob(root, job.id, { status: 'running', progress: 0.5 });

    expect(await interruptedDetections(root)).toEqual([]);
  });

  it('refuses to resume once two runs in a row have died the same way', async () => {
    const root = await project('crashloop');
    const { interruptedDetections } = await import('./jobs.js');

    await alreadyLost(root);
    await alreadyLost(root);
    await interrupted(root, { preset: 'balanced' });

    // A deploy interrupts one run. Two already behind this one is the signature
    // of work that kills the container, and resuming it is how a bad job takes
    // the whole service down.
    expect(await interruptedDetections(root)).toEqual([]);
  });

  it('still resumes when only the previous run was interrupted', async () => {
    const root = await project('one-deploy');
    const { interruptedDetections } = await import('./jobs.js');

    await alreadyLost(root);
    await interrupted(root, { preset: 'balanced' });

    expect(await interruptedDetections(root)).toHaveLength(1);
  });

  it('is not fooled by a run that finished for some other reason', async () => {
    const root = await project('mixed');
    const { createJob, updateJob, interruptedDetections } = await import('./jobs.js');

    await alreadyLost(root);
    const cancelled = await createJob(root, 'detection', {});
    await updateJob(root, cancelled.id, { status: 'canceled', error: 'Canceled by user.' });
    await interrupted(root, { preset: 'balanced' });

    // Only one of the two most recent was a restart, so this is not a loop.
    expect(await interruptedDetections(root)).toHaveLength(1);
  });

  it('has nothing to say about a project whose jobs all finished', async () => {
    const root = await project('quiet');
    const { createJob, updateJob, interruptedDetections } = await import('./jobs.js');

    const job = await createJob(root, 'detection', {});
    await updateJob(root, job.id, { status: 'completed', stage: 'done', progress: 1 });

    expect(await interruptedDetections(root)).toEqual([]);
  });
});
