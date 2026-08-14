import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type * as AnalyzeModule from './analyze.js';
import type * as FfmpegModule from './ffmpeg.js';

/**
 * "Find them in the rest of the game" searched the wrong file.
 *
 * With no video named — which is what the button sends — this took `videos[0]`
 * and stopped. A project gets a second upload as a matter of course: the 300s
 * test clip goes in first, the hour of game footage second. Production had
 * exactly that, and the search opened the clip, found nothing new there because
 * the athlete was already assigned across it, and reported "nothing else
 * followed on" about a game it never read a frame of.
 *
 * The worker is mocked because none of this is about colour: what is under test
 * is which videos get opened at all.
 */

const signature = (): number[] => Array.from({ length: 32 }, () => 1 / 32);

/** Every box the caller sends comes back matching, so links decide alone. */
const workerReply = (stdin: string): string => {
  const { boxes } = JSON.parse(stdin) as { boxes: { track: string }[] };
  const ids = [...new Set(boxes.map((box) => box.track))];
  return JSON.stringify({
    signatures: Object.fromEntries(ids.map((id) => [id, signature()])),
    pixels: Object.fromEntries(ids.map((id) => [id, 5_000])),
  });
};

const opened: string[] = [];
/** Videos the mocked worker refuses to read, by input path. */
const unreadable = new Set<string>();

vi.mock('./analyze.js', async () => {
  const actual = await vi.importActual<typeof AnalyzeModule>('./analyze.js');
  return { ...actual, resolveCvWorker: () => ({ command: 'cv', args: [] }) };
});

vi.mock('./ffmpeg.js', async () => {
  const actual = await vi.importActual<typeof FfmpegModule>('./ffmpeg.js');
  return {
    ...actual,
    run: (_command: string, args: string[], options: { stdin?: string }) => {
      const input = args[args.indexOf('--input') + 1] ?? '';
      opened.push(input);
      if (unreadable.has(input)) {
        return Promise.resolve({ code: 1, stdout: '', stderr: 'moov atom not found' });
      }
      return Promise.resolve({ code: 0, stdout: workerReply(options.stdin ?? '{}'), stderr: '' });
    },
  };
});

let home: string;
let root: string;
let athleteId: string;
/** trackId by a readable name, so assertions say what they mean. */
const ids = new Map<string, string>();

const probe = (durationSeconds: number): string =>
  JSON.stringify({ durationSeconds, video: { width: 1920, height: 1080 } });

beforeAll(async () => {
  home = mkdtempSync(path.join(tmpdir(), 'reeleel-propose-'));
  process.env['REELEEL_HOME'] = home;

  const { createProject, createTrack, execute, projectDb, addAthlete, assignTracksToAthlete } =
    await import('./index.js');
  const created = await createProject({
    name: 'propose',
    path: path.join(home, 'projects', 'propose'),
    sport: 'basketball',
  });
  root = created.path ?? created.root;

  const db = await projectDb(root);
  const now = new Date().toISOString();
  // Order matters: the clip is videos[0], the game is the one nobody searched.
  for (const [id, file, duration, order] of [
    ['vid_clip', '/tmp/output2.mp4', 300, 0],
    ['vid_game', '/tmp/input.webm', 3711, 1],
  ] as const) {
    await execute(
      db,
      'INSERT INTO source_videos (id, project_id, path, sort_order, probe_json, created_at, updated_at)' +
        ' VALUES (?, ?, ?, ?, ?, ?, ?)',
      [id, 'prj_test', file, order, probe(duration), now, now],
    );
  }

  /** A fragment at a fixed place on court, so every link is comfortably in reach. */
  const fragment = async (name: string, videoId: string, from: number, to: number) => {
    const track = await createTrack(root, {
      videoId,
      className: 'player',
      confidence: 0.9,
      samples: [
        { ts: from, frame: Math.round(from * 30), x: 100, y: 200, w: 40, h: 100, confidence: 0.9 },
        { ts: to, frame: Math.round(to * 30), x: 110, y: 200, w: 40, h: 100, confidence: 0.9 },
      ],
    });
    ids.set(name, track.id);
  };

  // The clip: the athlete is bound here, and there is one unbound neighbour.
  await fragment('clip-bound', 'vid_clip', 0, 5);
  await fragment('clip-next', 'vid_clip', 6, 11);
  // The game: bound on one fragment, with two more that carry on from it.
  await fragment('game-bound', 'vid_game', 100, 105);
  await fragment('game-next', 'vid_game', 106, 111);
  await fragment('game-later', 'vid_game', 112, 117);

  const athlete = await addAthlete(root, { name: 'Fred', jerseyColor: null });
  athleteId = athlete.id;
  await assignTracksToAthlete(root, athleteId, [
    ids.get('clip-bound') ?? '',
    ids.get('game-bound') ?? '',
  ]);
});

afterAll(async () => {
  const { resetDbCache } = await import('./index.js');
  resetDbCache();
  rmSync(home, { recursive: true, force: true });
  delete process.env['REELEEL_HOME'];
});

describe('finding the athlete in the rest of the game', () => {
  it('searches every video, not just the first upload', async () => {
    opened.length = 0;
    const { proposeAthleteTracks } = await import('./appearance.js');
    const found = await proposeAthleteTracks(root, athleteId, {});

    expect(opened).toEqual(['/tmp/output2.mp4', '/tmp/input.webm']);
    expect(found.searchedVideoIds).toEqual(['vid_clip', 'vid_game']);

    const proposed = found.proposals.map((proposal) => proposal.trackId);
    // The fragments in the hour-long game are the whole point: before this,
    // none of them could be proposed at all.
    expect(proposed).toContain(ids.get('game-next'));
    expect(proposed).toContain(ids.get('game-later'));
    expect(proposed).toContain(ids.get('clip-next'));
  });

  it('still honours an explicit video', async () => {
    opened.length = 0;
    const { proposeAthleteTracks } = await import('./appearance.js');
    const found = await proposeAthleteTracks(root, athleteId, { videoId: 'vid_game' });

    expect(opened).toEqual(['/tmp/input.webm']);
    expect(found.proposals.map((proposal) => proposal.trackId)).not.toContain(
      ids.get('clip-next'),
    );
  });

  it('does not lose the other videos when one cannot be read', async () => {
    opened.length = 0;
    unreadable.add('/tmp/output2.mp4');
    try {
      const { proposeAthleteTracks } = await import('./appearance.js');
      const found = await proposeAthleteTracks(root, athleteId, {});

      expect(found.searchedVideoIds).toEqual(['vid_game']);
      expect(found.skippedVideos?.map((skipped) => skipped.videoId)).toEqual(['vid_clip']);
      expect(found.proposals.map((proposal) => proposal.trackId)).toContain(ids.get('game-next'));
    } finally {
      unreadable.delete('/tmp/output2.mp4');
    }
  });

  it('fails when nothing could be read at all', async () => {
    unreadable.add('/tmp/output2.mp4');
    unreadable.add('/tmp/input.webm');
    try {
      const { proposeAthleteTracks } = await import('./appearance.js');
      await expect(proposeAthleteTracks(root, athleteId, {})).rejects.toThrow(/could not read/i);
    } finally {
      unreadable.clear();
    }
  });
});
