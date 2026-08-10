import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Marking the same child twice should leave you with one child.
 *
 * `new` created an athlete unconditionally, and the client sends `new` whenever
 * its own athlete list has not loaded — which is every click made faster than a
 * page reload. A user marking their kid on the footage, pausing, and clicking
 * again produced one athlete per click, each bound to a single fragment, each in
 * turn made focal. Scoring reads the focal flag, so a dozen careful selections
 * collapsed to whichever happened last. Production reached eight athletes, seven
 * of them duplicates created inside three minutes, with one selection in use.
 */

let home: string;
let root: string;
let app: Hono;

/**
 * The route fires a re-score and does not wait for it. It fails here, loudly
 * and harmlessly, because the fixture video is a path that does not exist —
 * that is the "1 source file(s) are no longer where they were imported from"
 * on stderr, and it is expected.
 */
beforeAll(async () => {
  home = mkdtempSync(path.join(tmpdir(), 'reeleel-identify-'));
  process.env['REELEEL_HOME'] = home;

  const { createProject } = await import('@reeleel/core');
  const created = await createProject({
    name: 'twice',
    path: path.join(home, 'projects', 'twice'),
    sport: 'basketball',
  });
  root = created.path ?? created.root;

  const { execute, projectDb, createTrack } = await import('@reeleel/core');
  const db = await projectDb(root);
  const now = new Date().toISOString();
  await execute(
    db,
    'INSERT INTO source_videos (id, project_id, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    ['vid_a', 'prj_test', '/tmp/vid_a.mp4', now, now],
  );
  for (let i = 0; i < 4; i += 1) {
    await createTrack(root, {
      videoId: 'vid_a',
      className: 'player',
      confidence: 0.9,
      samples: [
        { ts: i * 10, frame: i * 300, x: 1, y: 2, w: 3, h: 4, confidence: 0.9 },
        { ts: i * 10 + 5, frame: i * 300 + 150, x: 1, y: 2, w: 3, h: 4, confidence: 0.9 },
      ],
    });
  }

  const { registerActions } = await import('./actions.js');
  app = new Hono();
  registerActions(app);
});

afterAll(async () => {
  const { resetDbCache } = await import('@reeleel/core');
  resetDbCache();
  rmSync(home, { recursive: true, force: true });
  delete process.env['REELEEL_HOME'];
});

const trackIds = async (): Promise<string[]> => {
  const { listTracks } = await import('@reeleel/core');
  return (await listTracks(root, 'vid_a')).map((track) => track.id);
};

/** What the client posts when its athlete list has not loaded yet. */
const identify = async (ids: string[]): Promise<Response> =>
  app.request(`/projects/${encodeURIComponent(root)}/athletes/new/track`, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ trackId: ids[0], trackIds: ids }),
  });

describe('marking the same athlete over and over', () => {
  it('keeps one athlete and accumulates the fragments', async () => {
    const tracks = await trackIds();
    const { listAthletes, tracksForAthlete } = await import('@reeleel/core');

    // Six clicks, exactly as a user scrubbing the footage would make them.
    for (const id of tracks.slice(0, 3)) {
      const response = await identify([id]);
      expect(response.status).toBe(200);
    }

    const athletes = await listAthletes(root);
    expect(athletes).toHaveLength(1);

    // Every pick kept, not merely the last one.
    const bound = await tracksForAthlete(root, athletes[0]!.id);
    expect(bound.sort()).toEqual(tracks.slice(0, 3).sort());
    expect(athletes[0]!.isFocal).toBe(true);
  });

  it('still lets a named athlete replace their set, so unticking works', async () => {
    const tracks = await trackIds();
    const { listAthletes, tracksForAthlete } = await import('@reeleel/core');
    const athlete = (await listAthletes(root))[0]!;

    // The picker knows who it is talking about and sends the whole selection.
    const response = await app.request(
      `/projects/${encodeURIComponent(root)}/athletes/${athlete.id}/track`,
      {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({ trackId: tracks[0], trackIds: [tracks[0]] }),
      },
    );
    expect(response.status).toBe(200);

    expect(await tracksForAthlete(root, athlete.id)).toEqual([tracks[0]]);
    expect(await listAthletes(root)).toHaveLength(1);
  });

  it('creates exactly one athlete for a project that has none', async () => {
    const { listAthletes } = await import('@reeleel/core');
    expect(await listAthletes(root)).toHaveLength(1);
  });
});
