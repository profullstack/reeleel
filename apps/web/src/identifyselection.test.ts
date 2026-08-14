import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * "Identify as my athlete (30 selected)" — beside four crops and "89s".
 *
 * The grid is both the picker and the only view of what has already been
 * picked, and it was only ever built for the first job: forty tracks, longest
 * first, nothing under 1.5s. Stitching works down to a quarter of a second and
 * across uploads, so production reached thirty assigned tracks of which four
 * had a tile. The count came from somewhere the user could not see, the seconds
 * counted only the visible four, and twenty-six choices could not be undone.
 *
 * What is fixed here is that the selection is always on screen: a track this
 * athlete is assigned to gets a tile whatever the limit and the floor say.
 */

let home: string;
let root: string;
let app: Hono;
let athleteId: string;
let assigned: string[] = [];

const probe = JSON.stringify({ durationSeconds: 3711, video: { width: 1920, height: 1080 } });

beforeAll(async () => {
  home = mkdtempSync(path.join(tmpdir(), 'reeleel-selection-'));
  process.env['REELEEL_HOME'] = home;

  const { createProject } = await import('@reeleel/core');
  const created = await createProject({
    name: 'selection',
    path: path.join(home, 'projects', 'selection'),
    sport: 'basketball',
  });
  root = created.path ?? created.root;

  const { execute, projectDb, createTrack, addAthlete, assignTracksToAthlete } = await import(
    '@reeleel/core'
  );
  const db = await projectDb(root);
  const now = new Date().toISOString();
  for (const [id, file, order] of [
    ['vid_clip', '/tmp/output2.mp4', 0],
    ['vid_game', '/tmp/input.webm', 1],
  ] as const) {
    await execute(
      db,
      'INSERT INTO source_videos (id, project_id, path, sort_order, probe_json, created_at, updated_at)' +
        ' VALUES (?, ?, ?, ?, ?, ?, ?)',
      [id, 'prj_test', file, order, probe, now, now],
    );
  }

  const fragment = async (videoId: string, from: number, seconds: number): Promise<string> => {
    const track = await createTrack(root, {
      videoId,
      className: 'player',
      confidence: 0.9,
      samples: [
        { ts: from, frame: Math.round(from * 30), x: 100, y: 200, w: 40, h: 100, confidence: 0.9 },
        {
          ts: from + seconds,
          frame: Math.round((from + seconds) * 30),
          x: 110,
          y: 200,
          w: 40,
          h: 100,
          confidence: 0.9,
        },
      ],
    });
    return track.id;
  };

  // Sixty long tracks in the game: more than the grid's own limit, so the
  // short ones below could never have made the cut on length.
  for (let i = 0; i < 60; i += 1) await fragment('vid_game', i * 40, 30);

  // What the stitcher actually produced for this athlete: a couple of long
  // fragments, and a tail of sub-second ones from the earlier upload.
  assigned = [
    await fragment('vid_game', 2500, 27.6),
    await fragment('vid_game', 2540, 22.1),
    await fragment('vid_clip', 10, 0.4),
    await fragment('vid_clip', 20, 0.3),
    await fragment('vid_clip', 30, 0.9),
  ];

  const athlete = await addAthlete(root, { name: 'Fred', jerseyColor: 'white' });
  athleteId = athlete.id;
  await assignTracksToAthlete(root, athleteId, assigned);

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

interface CandidatesBody {
  ok: boolean;
  candidates: { trackId: string; videoId: string; seconds: number }[];
  assignedTrackIds: string[];
  videos: { id: string; label: string; order: number }[];
}

const candidates = async (): Promise<CandidatesBody> => {
  const response = await app.request(`/projects/${encodeURIComponent(root)}/candidates`, {
    headers: { accept: 'application/json' },
  });
  expect(response.status).toBe(200);
  return (await response.json()) as CandidatesBody;
};

describe('the candidate grid', () => {
  it('draws every track the athlete is already assigned to', async () => {
    const body = await candidates();
    expect(body.assignedTrackIds.sort()).toEqual([...assigned].sort());

    const drawn = new Set(body.candidates.map((candidate) => candidate.trackId));
    for (const trackId of assigned) expect(drawn.has(trackId)).toBe(true);
  });

  it('keeps sub-second fragments the picker itself would never offer', async () => {
    // Under the 1.5s floor and nowhere near the sixty longest: only being
    // picked puts these on screen, which is the only way to unpick them.
    const body = await candidates();
    const short = body.candidates.filter((candidate) => candidate.seconds < 1.5);
    expect(short.length).toBe(3);
    for (const candidate of short) expect(assigned).toContain(candidate.trackId);
  });

  it('lets the selection and the coverage agree', async () => {
    const body = await candidates();
    // The panel sums the tiles it can see. Every assignment having a tile is
    // what stops "30 selected" reading beside 4 crops and 89s.
    const visible = body.candidates.filter((candidate) =>
      body.assignedTrackIds.includes(candidate.trackId),
    );
    expect(visible.length).toBe(body.assignedTrackIds.length);
  });

  it('says which upload each crop came from', async () => {
    const body = await candidates();
    expect(body.videos.map((video) => video.label)).toEqual(['output2.mp4', 'input.webm']);
    const fromClip = body.candidates.filter((candidate) => candidate.videoId === 'vid_clip');
    expect(fromClip.length).toBeGreaterThan(0);
  });

  it('still limits the tracks nobody has picked', async () => {
    const body = await candidates();
    const unpicked = body.candidates.filter(
      (candidate) => !body.assignedTrackIds.includes(candidate.trackId),
    );
    expect(unpicked.length).toBe(40);
  });
});
