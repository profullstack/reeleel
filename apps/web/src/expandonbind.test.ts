import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * One click on the footage should mark the child for the game, not the second.
 *
 * Stitching a pick into the fragments either side of it shipped with the
 * appearance matcher, but the only route to it was the candidate grid, which
 * offers proposals to tick. The scrubber — where people actually identify,
 * because pointing at your own child needs no explanation — bound the one track
 * under the cursor and stopped. Production shows the consequence exactly: an
 * athlete on 2 tracks out of 1125, and one suggested moment, in a game they
 * played all of.
 *
 * Expansion needs a CV worker and real frames, so what is asserted here is the
 * contract around it: the request is accepted, the pick itself is never lost to
 * a failure to widen it, and the flag is what decides whether widening is even
 * attempted.
 */

let home: string;
let root: string;
let app: Hono;

beforeAll(async () => {
  home = mkdtempSync(path.join(tmpdir(), 'reeleel-expand-'));
  process.env['REELEEL_HOME'] = home;

  const { createProject } = await import('@reeleel/core');
  const created = await createProject({
    name: 'expand',
    path: path.join(home, 'projects', 'expand'),
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

const post = async (body: unknown): Promise<Response> =>
  app.request(`/projects/${encodeURIComponent(root)}/athletes/new/track`, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('identifying from the scrubber', () => {
  it('keeps the pick even when the athlete cannot be followed any further', async () => {
    const { listTracks, listAthletes, tracksForAthlete } = await import('@reeleel/core');
    const tracks = (await listTracks(root, 'vid_a')).map((track) => track.id);

    // There is no video behind this fixture, so expansion cannot succeed. The
    // pick is the part the user made; losing it to a failed widening would be
    // strictly worse than never widening at all.
    const response = await post({ trackId: tracks[0], trackIds: [tracks[0]], expand: true });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; added: number };
    expect(body.ok).toBe(true);
    expect(body.added).toBe(0);

    const athletes = await listAthletes(root);
    expect(athletes).toHaveLength(1);
    expect(await tracksForAthlete(root, athletes[0]!.id)).toEqual([tracks[0]]);
  });

  it('records who they are, colour and all, from the same click', async () => {
    const { listTracks, listAthletes } = await import('@reeleel/core');
    const tracks = (await listTracks(root, 'vid_a')).map((track) => track.id);

    await post({
      trackId: tracks[1],
      trackIds: [tracks[1]],
      expand: true,
      name: 'Fred',
      jerseyNumber: '14',
      jerseyColor: 'white',
      team: 'Triton',
    });

    const athlete = (await listAthletes(root))[0]!;
    expect(athlete.name).toBe('Fred');
    expect(athlete.jerseyNumber).toBe('14');
    // The field that has existed since the first migration and was never written.
    expect(athlete.jerseyColor).toBe('white');
    expect(athlete.team).toBe('Triton');
  });

  it('still accumulates picks rather than replacing them', async () => {
    const { listTracks, listAthletes, tracksForAthlete } = await import('@reeleel/core');
    const tracks = (await listTracks(root, 'vid_a')).map((track) => track.id);

    await post({ trackId: tracks[2], trackIds: [tracks[2]], expand: true });

    const athlete = (await listAthletes(root))[0]!;
    const bound = await tracksForAthlete(root, athlete.id);
    // Three clicks, three fragments, one child — widening must not undo the
    // de-duplication that made repeat clicks safe in the first place.
    expect(bound.sort()).toEqual(tracks.slice(0, 3).sort());
    expect(await listAthletes(root)).toHaveLength(1);
  });

  it('leaves a caller that did not ask to expand exactly as it was', async () => {
    const { listTracks } = await import('@reeleel/core');
    const tracks = (await listTracks(root, 'vid_a')).map((track) => track.id);

    const response = await post({ trackId: tracks[3], trackIds: [tracks[3]] });
    const body = (await response.json()) as { ok: boolean; added: number };
    expect(body.ok).toBe(true);
    expect(body.added).toBe(0);
  });
});
