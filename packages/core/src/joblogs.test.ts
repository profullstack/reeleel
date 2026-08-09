import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

let home: string;

beforeAll(() => {
  home = mkdtempSync(path.join(tmpdir(), 'reeleel-joblogs-'));
  process.env['REELEEL_HOME'] = home;
});

afterAll(async () => {
  const { resetDbCache } = await import('./db.js');
  resetDbCache();
  rmSync(home, { recursive: true, force: true });
  delete process.env['REELEEL_HOME'];
});

const freshProject = async (name = 'Log Game') => {
  const { createProject } = await import('./projects.js');
  return createProject({
    name,
    path: path.join(home, 'projects', `${name}-${Date.now()}-${Math.random()}`),
  });
};

describe('incremental job logs', () => {
  beforeEach(async () => {
    const { resetDbCache } = await import('./db.js');
    resetDbCache();
  });

  /**
   * The cursor is what makes a live feed possible: it has to answer "what
   * happened since I last looked" without re-sending history or dropping a line
   * that landed between two polls.
   */
  it('returns only what is new, and never repeats a line', async () => {
    const { createJob, listJobLogsSince, logJob } = await import('./jobs.js');
    const { root } = await freshProject();
    const job = await createJob(root, 'detection');

    await logJob(root, job.id, 'proxy: game.mp4');
    await logJob(root, job.id, 'detection: game.mp4');

    const first = await listJobLogsSince(root, 0);
    expect(first.map((line) => line.message)).toEqual(['proxy: game.mp4', 'detection: game.mp4']);
    expect(first.every((line) => line.jobId === job.id)).toBe(true);

    const cursor = first[first.length - 1]?.id ?? 0;
    expect(await listJobLogsSince(root, cursor)).toEqual([]);

    await logJob(root, job.id, 'scoring');
    const second = await listJobLogsSince(root, cursor);
    expect(second.map((line) => line.message)).toEqual(['scoring']);
    // Ids only ever move forward, so a client can resume from the last one.
    expect(second[0]!.id).toBeGreaterThan(cursor);
  });

  it('keeps lines in the order they were written', async () => {
    const { createJob, listJobLogsSince, logJob } = await import('./jobs.js');
    const { root } = await freshProject('Ordered');
    const job = await createJob(root, 'detection');

    for (let n = 0; n < 25; n += 1) await logJob(root, job.id, `stage ${n}`);

    const lines = await listJobLogsSince(root, 0);
    expect(lines.map((line) => line.message)).toEqual(
      Array.from({ length: 25 }, (_unused, n) => `stage ${n}`),
    );
  });

  it('preserves the level, so an error can be shown as one', async () => {
    const { createJob, listJobLogsSince, logJob } = await import('./jobs.js');
    const { root } = await freshProject('Levels');
    const job = await createJob(root, 'detection');

    await logJob(root, job.id, 'fine');
    await logJob(root, job.id, 'careful', 'warn');
    await logJob(root, job.id, 'MODEL_MISSING: no detector weights', 'error');

    const lines = await listJobLogsSince(root, 0);
    expect(lines.map((line) => line.level)).toEqual(['info', 'warn', 'error']);
    expect(lines.at(-1)?.message).toContain('MODEL_MISSING');
  });

  it('gives a newly-opened feed the tail of the log for context', async () => {
    const { createJob, listRecentJobLogs, logJob } = await import('./jobs.js');
    const { root } = await freshProject('Tail');
    const job = await createJob(root, 'detection');

    for (let n = 0; n < 30; n += 1) await logJob(root, job.id, `line ${n}`);

    const recent = await listRecentJobLogs(root, 5);
    // The last five, still in reading order rather than reversed.
    expect(recent.map((line) => line.message)).toEqual([
      'line 25',
      'line 26',
      'line 27',
      'line 28',
      'line 29',
    ]);
  });

  it('spans every job in the project, which is what a project feed shows', async () => {
    const { createJob, listJobLogsSince, logJob } = await import('./jobs.js');
    const { root } = await freshProject('Multi');
    const first = await createJob(root, 'detection');
    const second = await createJob(root, 'render');

    await logJob(root, first.id, 'from detection');
    await logJob(root, second.id, 'from render');

    const lines = await listJobLogsSince(root, 0);
    expect(lines.map((line) => line.jobId)).toEqual([first.id, second.id]);
  });
});
