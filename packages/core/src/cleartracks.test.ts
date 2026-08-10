import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Detection appended its tracks unconditionally, so every re-analysis layered
 * another copy of every track over the last. A real project analysed six times
 * held 9961 tracks from a run that produced 1525 — scoring against six
 * overlapping sets of the same players, including sets produced by runs later
 * found to be broken.
 *
 * `focal_track_id` is a bare column with no foreign key, so replacing tracks
 * also has to clear the athlete binding, or scoring keeps an anchor pointed at
 * a row that no longer exists.
 */

let home: string;

beforeAll(() => {
  home = mkdtempSync(path.join(tmpdir(), 'reeleel-cleartracks-'));
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

const sample = (ts: number) => ({ ts, frame: ts * 30, x: 1, y: 2, w: 3, h: 4, confidence: 0.9 });

/**
 * tracks.video_id has a foreign key to source_videos, and addVideo probes a real
 * file with ffprobe. Insert the row directly: these tests are about deletion,
 * not import.
 */
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

describe('replacing a video’s tracks instead of appending to them', () => {
  it('removes only the named video’s tracks, and reports how many', async () => {
    const root = await project('replace');
    await video(root, 'vid_a');
    await video(root, 'vid_b');
    const { createTrack, clearTracks, listTracks } = await import('./tracks.js');

    for (let n = 0; n < 3; n += 1) {
      await createTrack(root, {
        videoId: 'vid_a',
        className: 'player',
        confidence: 0.9,
        samples: [sample(0), sample(1)],
      });
    }
    await createTrack(root, {
      videoId: 'vid_b',
      className: 'player',
      confidence: 0.9,
      samples: [sample(0), sample(1)],
    });

    const cleared = await clearTracks(root, 'vid_a');
    expect(cleared.removed).toBe(3);
    // The other video is untouched: analysing one clip must not wipe another.
    expect(await listTracks(root, 'vid_a')).toHaveLength(0);
    expect(await listTracks(root, 'vid_b')).toHaveLength(1);
  });

  it('unbinds an athlete whose focal track is being deleted', async () => {
    const root = await project('unbind');
    await video(root, 'vid_a');
    const { createTrack, clearTracks } = await import('./tracks.js');
    const { addAthlete, updateAthlete, getAthlete } = await import('./athletes.js');

    const track = await createTrack(root, {
      videoId: 'vid_a',
      className: 'player',
      confidence: 0.9,
      samples: [sample(0), sample(1)],
    });
    const athlete = await addAthlete(root, { name: 'Kid' });
    await updateAthlete(root, athlete.id, { focalTrackId: track.id, focal: true });

    const cleared = await clearTracks(root, 'vid_a');
    expect(cleared.unboundAthletes).toEqual([athlete.id]);
    // Left dangling, scoring would silently lose its anchor and report nothing.
    expect((await getAthlete(root, athlete.id)).focalTrackId).toBeNull();
  });

  it('leaves an athlete bound to a different video alone', async () => {
    const root = await project('other-video');
    await video(root, 'vid_a');
    await video(root, 'vid_b');
    const { createTrack, clearTracks } = await import('./tracks.js');
    const { addAthlete, updateAthlete, getAthlete } = await import('./athletes.js');

    const keep = await createTrack(root, {
      videoId: 'vid_b',
      className: 'player',
      confidence: 0.9,
      samples: [sample(0), sample(1)],
    });
    await createTrack(root, {
      videoId: 'vid_a',
      className: 'player',
      confidence: 0.9,
      samples: [sample(0), sample(1)],
    });
    const athlete = await addAthlete(root, { name: 'Kid' });
    await updateAthlete(root, athlete.id, { focalTrackId: keep.id, focal: true });

    const cleared = await clearTracks(root, 'vid_a');
    expect(cleared.unboundAthletes).toEqual([]);
    expect((await getAthlete(root, athlete.id)).focalTrackId).toBe(keep.id);
  });

  it('is a no-op on a video that has no tracks', async () => {
    const root = await project('empty');
    const { clearTracks } = await import('./tracks.js');
    expect(await clearTracks(root, 'vid_missing')).toEqual({ removed: 0, unboundAthletes: [] });
  });
});
