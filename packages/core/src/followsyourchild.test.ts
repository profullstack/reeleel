import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * "It's still not tracking #14 white."
 *
 * Measured on the 61-minute game that prompted this: the focal athlete was
 * "Fred, #14 in white", `focal_track_id` was null, and no track carried his
 * athlete id — the eight clicks that had marked him were sitting on eight other
 * athlete rows. Nothing anywhere said so. Scoring fell through to the two
 * signals that never look at the athlete and produced 38 moments of
 * `activity_near_goal` + `high_motion`, each one a single window plus its
 * pre/post roll; the job logged "done" in green because its diagnosis only
 * speaks when a run returns nothing at all; and the Virtual Cameraman, asked to
 * follow a player it had no track for, followed `tracks.find(className ===
 * 'player')` — the first child in the list.
 *
 * Every clip in that reel therefore followed somebody else's kid, which from
 * the outside is indistinguishable from tracking that keeps losing yours.
 */

let home: string;

beforeAll(() => {
  home = mkdtempSync(path.join(tmpdir(), 'reeleel-follow-'));
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
    sport: 'basketball',
    path: path.join(home, 'projects', `${name}-${process.hrtime.bigint()}`),
  });
  return created.root;
};

/** A video row with a probe, without needing ffprobe or a real file. */
const video = async (root: string, id: string, durationSeconds = 60): Promise<void> => {
  const { execute, projectDb } = await import('./db.js');
  const db = await projectDb(root);
  const now = new Date().toISOString();
  await execute(
    db,
    `INSERT INTO source_videos (id, project_id, path, probe_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      id,
      'prj_test',
      `/tmp/${id}.mp4`,
      JSON.stringify({ durationSeconds, video: { width: 1920, height: 1080 } }),
      now,
      now,
    ],
  );
};

const walk = (
  from: number,
  to: number,
  at: (ts: number) => { x: number; y: number },
): { ts: number; frame: number; x: number; y: number; w: number; h: number; confidence: number }[] => {
  const samples = [];
  for (let ts = from; ts <= to; ts += 0.5) {
    samples.push({ ts, frame: Math.round(ts * 30), ...at(ts), w: 70, h: 170, confidence: 0.9 });
  }
  return samples;
};

describe('the camera follows the child you pointed at', () => {
  it('follows him across every fragment he was marked in, not just the bound one', async () => {
    const root = await project('fragments');
    await video(root, 'vid_a');
    const { createTrack } = await import('./tracks.js');
    const { assignTracksToAthlete } = await import('./tracks.js');
    const { addAthlete, updateAthlete } = await import('./athletes.js');
    const { buildClipFilter } = await import('./render.js');

    // The same child, in two pieces, on opposite sides of the court. The
    // tracker breaks an athlete up at every occlusion; the picker gathers the
    // pieces back together and the camera has to read all of them.
    const early = await createTrack(root, {
      videoId: 'vid_a',
      className: 'player',
      confidence: 0.9,
      samples: walk(0, 4, () => ({ x: 120, y: 500 })),
    });
    const late = await createTrack(root, {
      videoId: 'vid_a',
      className: 'player',
      confidence: 0.9,
      samples: walk(6, 10, () => ({ x: 1700, y: 500 })),
    });

    const athlete = await addAthlete(root, { name: 'Fred', jerseyNumber: '14' });
    await updateAthlete(root, athlete.id, { focalTrackId: early.id, focal: true });
    await assignTracksToAthlete(root, athlete.id, [early.id, late.id]);

    const filter = await buildClipFilter(
      root,
      {
        id: 'clp_x',
        projectId: 'prj_test',
        momentId: null,
        videoId: 'vid_a',
        start: 0,
        end: 10,
        sortOrder: 0,
        cameraMode: 'follow-player',
        title: null,
        renderedPath: null,
        manual: false,
        createdAt: '',
        updatedAt: '',
      },
      '16:9',
    );

    /**
     * The crop is expressed as a piecewise `if` chain over `t`, so the numbers
     * in it are the path. Reading `focal_track_id` alone, the camera saw him
     * only to 4s and sat where it lost him; following the whole set it has to
     * travel to the far side of the court by the end of the clip.
     */
    const xs = [...filter.matchAll(/x='([^']*)'/g)][0]?.[1] ?? '';
    const numbers = [...xs.matchAll(/,(\d+)\)/g)].map((match) => Number(match[1]));
    expect(numbers.length).toBeGreaterThan(0);
    expect(Math.max(...numbers)).toBeGreaterThan(400);
  });

  it('frames wide rather than following a stranger when nobody is bound', async () => {
    const root = await project('stranger');
    await video(root, 'vid_a');
    const { createTrack } = await import('./tracks.js');
    const { addAthlete, updateAthlete } = await import('./athletes.js');
    const { buildClipFilter } = await import('./render.js');

    // Somebody else's child, and the only player track in the project.
    await createTrack(root, {
      videoId: 'vid_a',
      className: 'player',
      confidence: 0.9,
      samples: walk(0, 10, (ts) => ({ x: 100 + ts * 150, y: 500 })),
    });
    // Named, never pointed at — exactly the production row.
    const athlete = await addAthlete(root, {
      name: 'Fred',
      jerseyNumber: '14',
      jerseyColor: 'white',
    });
    await updateAthlete(root, athlete.id, { focal: true });

    const filter = await buildClipFilter(
      root,
      {
        id: 'clp_y',
        projectId: 'prj_test',
        momentId: null,
        videoId: 'vid_a',
        start: 0,
        end: 10,
        sortOrder: 0,
        cameraMode: 'follow-player',
        title: null,
        renderedPath: null,
        manual: false,
        createdAt: '',
        updatedAt: '',
      },
      '16:9',
    );

    // No crop path at all: the full frame, scaled and padded. Following the
    // stranger would have produced a moving `crop=` chain that looks, on the
    // export, exactly like tracking that lost your child.
    expect(filter.startsWith('crop=')).toBe(false);
  });
});

describe('scoring says when nobody is bound', () => {
  it('reports the named athlete nothing was bound to', async () => {
    const root = await project('unbound');
    await video(root, 'vid_a');
    const { createTrack } = await import('./tracks.js');
    const { addAthlete, updateAthlete } = await import('./athletes.js');
    const { generateMoments } = await import('./moments.js');

    await createTrack(root, {
      videoId: 'vid_a',
      className: 'player',
      confidence: 0.9,
      samples: walk(0, 20, (ts) => ({ x: 100 + ts * 40, y: 500 })),
    });
    const athlete = await addAthlete(root, {
      name: 'Fred',
      jerseyNumber: '14',
      jerseyColor: 'white',
    });
    await updateAthlete(root, athlete.id, { focal: true });

    const result = await generateMoments(root, { replace: true });
    expect(result.unboundAthlete).toEqual({ id: athlete.id, label: 'Fred (#14 in white)' });
  });

  it('does not stamp his name on moments no signal of his contributed to', async () => {
    const root = await project('attribution');
    await video(root, 'vid_a');
    const { createTrack } = await import('./tracks.js');
    const { addAthlete, updateAthlete } = await import('./athletes.js');
    const { generateMoments, listMoments } = await import('./moments.js');

    // Enough motion near a rim for the scene signals to clear the threshold —
    // the shape of footage that produced 38 moments about nobody in particular.
    for (let n = 0; n < 4; n += 1) {
      await createTrack(root, {
        videoId: 'vid_a',
        className: 'player',
        confidence: 0.9,
        samples: walk(0, 20, (ts) => ({
          x: 1400 + Math.sin(ts * 3 + n) * 200,
          y: 300 + Math.cos(ts * 2 + n) * 150,
        })),
      });
    }
    await createTrack(root, {
      videoId: 'vid_a',
      className: 'hoop',
      confidence: 0.9,
      samples: walk(0, 20, () => ({ x: 1500, y: 200 })),
    });
    const athlete = await addAthlete(root, { name: 'Fred', jerseyNumber: '14' });
    await updateAthlete(root, athlete.id, { focal: true });

    await generateMoments(root, { replace: true });
    const moments = await listMoments(root);
    // Whatever the scene scored, none of it is a claim about Fred.
    expect(moments.every((moment) => moment.athleteId === null)).toBe(true);
  });

  it('says nothing when the athlete is properly bound', async () => {
    const root = await project('bound');
    await video(root, 'vid_a');
    const { createTrack, assignTracksToAthlete } = await import('./tracks.js');
    const { addAthlete, updateAthlete } = await import('./athletes.js');
    const { generateMoments } = await import('./moments.js');

    const track = await createTrack(root, {
      videoId: 'vid_a',
      className: 'player',
      confidence: 0.9,
      samples: walk(0, 20, (ts) => ({ x: 100 + ts * 40, y: 500 })),
    });
    const athlete = await addAthlete(root, { name: 'Fred' });
    await updateAthlete(root, athlete.id, { focal: true });
    await assignTracksToAthlete(root, athlete.id, [track.id]);

    const result = await generateMoments(root, { replace: true });
    expect(result.unboundAthlete).toBeNull();
  });
});
