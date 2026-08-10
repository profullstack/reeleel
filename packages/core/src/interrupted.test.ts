import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Analysis runs inside the web process, so a deploy takes it with it. The job
 * row kept saying `running` for ever, and a detection pass killed at frame 7350
 * of 9000 was indistinguishable in the UI from one still going — the progress
 * simply stopped advancing, which is also what a slow pass looks like.
 *
 * At startup this process owns no running work by definition, so anything still
 * marked running was interrupted and nothing is coming to finish it.
 */

let home: string;

beforeAll(() => {
  home = mkdtempSync(path.join(tmpdir(), 'reeleel-interrupted-'));
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

describe('jobs left behind by a restart', () => {
  it('fails a running job, and says why on the job itself', async () => {
    const root = await project('running');
    const { createJob, updateJob, getJob, failInterruptedJobs, listJobLogsSince } = await import(
      './jobs.js'
    );

    const job = await createJob(root, 'detection', {});
    await updateJob(root, job.id, { status: 'running', stage: 'detection', progress: 0.8 });

    expect(await failInterruptedJobs(root)).toBe(1);
    const after = await getJob(root, job.id);
    expect(after.status).toBe('failed');
    expect(after.error).toContain('restart');

    // The reason has to reach the log, which is where the user is looking.
    const logs = (await listJobLogsSince(root, 0)).filter((entry) => entry.jobId === job.id);
    expect(logs.some((entry) => entry.message.includes('interrupted'))).toBe(true);
  });

  it('fails a queued job too, since nothing will pick it up', async () => {
    const root = await project('queued');
    const { createJob, getJob, failInterruptedJobs } = await import('./jobs.js');
    const job = await createJob(root, 'render', {});
    expect(await failInterruptedJobs(root)).toBe(1);
    expect((await getJob(root, job.id)).status).toBe('failed');
  });

  it('leaves finished work alone', async () => {
    const root = await project('finished');
    const { createJob, updateJob, getJob, failInterruptedJobs } = await import('./jobs.js');

    const done = await createJob(root, 'detection', {});
    await updateJob(root, done.id, { status: 'completed', stage: 'done', progress: 1 });
    const failedJob = await createJob(root, 'detection', {});
    await updateJob(root, failedJob.id, { status: 'failed', error: 'something else' });

    expect(await failInterruptedJobs(root)).toBe(0);
    expect((await getJob(root, done.id)).status).toBe('completed');
    // The original reason must survive, not be overwritten by the sweep.
    expect((await getJob(root, failedJob.id)).error).toBe('something else');
  });

  it('is a no-op on a project with no jobs', async () => {
    const root = await project('empty');
    const { failInterruptedJobs } = await import('./jobs.js');
    expect(await failInterruptedJobs(root)).toBe(0);
  });
});
