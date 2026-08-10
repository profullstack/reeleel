import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * A re-bind has to be able to *grow* an athlete's coverage, not merely survive.
 *
 * Matching took the single best new track per old track, so N fragments in gave
 * at most N fragments out — however the new run happened to cut the same child
 * up. In production a binding to one ten-frame fragment came back from
 * re-detection as one ten-frame fragment, twice in a row, over runs that
 * produced 3,948 and then 1,415 tracks. The athlete every focal signal depends
 * on was therefore present for 0.3s of a 300s game, and the run suggested
 * nothing while reporting "athlete identified: yes".
 */

let home: string;

beforeAll(() => {
  home = mkdtempSync(path.join(tmpdir(), 'reeleel-rebindgrow-'));
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
  return created.path ?? created.root;
};

const video = async (root: string, id: string): Promise<void> => {
  const { execute, projectDb } = await import('./db.js');
  const db = await projectDb(root);
  const now = new Date().toISOString();
  await execute(
    db,
    'INSERT INTO source_videos (id, project_id, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    [id, 'prj_test', `/tmp/${id}.mp4`, now, now],
  );
};

/** Dense samples along a straight walk, the way the tracker emits them. */
const walk = (from: number, to: number, offset = 0) => {
  const out = [];
  for (let i = 0; i <= Math.round((to - from) * 4); i += 1) {
    const ts = from + i / 4;
    out.push({ ts, frame: Math.round(ts * 30), x: 100 + ts * 10 + offset, y: 300, w: 40, h: 100, confidence: 0.9 });
  }
  return out;
};

describe('re-identifying an athlete across a re-detection', () => {
  it('picks up every new fragment of the athlete, not one per old fragment', async () => {
    const root = await project('grow');
    await video(root, 'vid_a');
    const { createTrack, clearTracks, snapshotAthleteBindings, rebindAthletes, tracksForAthlete } =
      await import('./tracks.js');
    const { addAthlete, updateAthlete } = await import('./athletes.js');

    // The old run saw the child as one long track.
    const old = await createTrack(root, {
      videoId: 'vid_a',
      className: 'player',
      confidence: 0.9,
      samples: walk(0, 30),
    });
    const athlete = await addAthlete(root, { name: 'Kid' });
    await updateAthlete(root, athlete.id, { focalTrackId: old.id, focal: true });

    const remembered = await snapshotAthleteBindings(root, 'vid_a');
    await clearTracks(root, 'vid_a');

    // The new run cuts the same child into three consecutive pieces, and also
    // sees a different child on the far side of the court throughout.
    for (const [from, to] of [
      [0, 9],
      [10, 19],
      [20, 30],
    ] as const) {
      await createTrack(root, {
        videoId: 'vid_a',
        className: 'player',
        confidence: 0.9,
        samples: walk(from, to, 2),
      });
    }
    await createTrack(root, {
      videoId: 'vid_a',
      className: 'player',
      confidence: 0.9,
      samples: walk(0, 30, 900),
    });

    const restored = await rebindAthletes(root, 'vid_a', remembered);
    expect(restored).toHaveLength(1);

    /**
     * All three pieces, which is the whole point. One-best-per-old-track would
     * return exactly one here and silently drop two thirds of the athlete.
     */
    const assigned = await tracksForAthlete(root, athlete.id);
    expect(assigned).toHaveLength(3);
  });

  it('still refuses a child who merely walked through the same space later', async () => {
    const root = await project('stranger');
    await video(root, 'vid_a');
    const { createTrack, clearTracks, snapshotAthleteBindings, rebindAthletes, tracksForAthlete } =
      await import('./tracks.js');
    const { addAthlete, updateAthlete } = await import('./athletes.js');

    const old = await createTrack(root, {
      videoId: 'vid_a',
      className: 'player',
      confidence: 0.9,
      samples: walk(0, 30),
    });
    const athlete = await addAthlete(root, { name: 'Kid' });
    await updateAthlete(root, athlete.id, { focalTrackId: old.id, focal: true });

    const remembered = await snapshotAthleteBindings(root, 'vid_a');
    await clearTracks(root, 'vid_a');

    // Same path, a different half of the game: never on screen together, so not
    // the same person as far as anything here can tell.
    await createTrack(root, {
      videoId: 'vid_a',
      className: 'player',
      confidence: 0.9,
      samples: walk(200, 230),
    });
    // And the real athlete.
    await createTrack(root, {
      videoId: 'vid_a',
      className: 'player',
      confidence: 0.9,
      samples: walk(0, 30, 2),
    });

    await rebindAthletes(root, 'vid_a', remembered);
    const assigned = await tracksForAthlete(root, athlete.id);
    expect(assigned).toHaveLength(1);
  });
});
