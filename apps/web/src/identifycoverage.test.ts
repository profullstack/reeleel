import { describe, expect, it } from 'vitest';

import { coverageOf, withProposals } from './client/identify.js';
import type { Candidate, Match, VideoRef } from './client/identify.js';

/**
 * The two numbers on the picker disagreed with each other.
 *
 * "Identify as my athlete (30 selected)" counted every track the server had
 * assigned; "89s of footage followed" summed only the tracks the grid was
 * drawing, which was four of them. And "find them in the rest of the game"
 * ticked proposals the grid had no tile for, so the count moved and no crop
 * appeared — indistinguishable from a button that does nothing.
 */

const candidate = (trackId: string, seconds: number, videoId = 'vid_game'): Candidate => ({
  trackId,
  videoId,
  className: 'player',
  seconds,
  samples: 30,
  confidence: 0.9,
  previewTs: 10,
  thumbIndex: 1,
  box: { x: 1, y: 2, w: 3, h: 4 },
  sourceWidth: 1920,
  sourceHeight: 1080,
});

const proposal = (trackId: string, seconds: number, videoId = 'vid_game'): Candidate & Match => ({
  ...candidate(trackId, seconds, videoId),
  score: 0.82,
  gapSeconds: 1.2,
  distancePx: 40,
});

const videos: VideoRef[] = [
  { id: 'vid_clip', label: 'output2.mp4', order: 1 },
  { id: 'vid_game', label: 'input.webm', order: 2 },
];

describe('proposals joining the grid', () => {
  it('adds a proposal the grid was never going to show', () => {
    // 0.4s is far under the picker's 1.5s floor: stitching found it, and only
    // this puts it on screen where it can be confirmed or rejected.
    const merged = withProposals([candidate('trk_a', 20)], [proposal('trk_b', 0.4)]);
    expect(merged.map((entry) => entry.trackId)).toEqual(['trk_a', 'trk_b']);
  });

  it('never duplicates a tile that is already there', () => {
    const merged = withProposals([candidate('trk_a', 20)], [proposal('trk_a', 20)]);
    expect(merged).toHaveLength(1);
  });

  it('drops the match fields, which belong to the score map', () => {
    const [added] = withProposals([], [proposal('trk_b', 5)]);
    expect(added).toBeDefined();
    expect(Object.keys(added ?? {})).not.toContain('score');
  });
});

describe('the coverage line', () => {
  it('counts every fragment that has a tile', () => {
    const line = coverageOf([candidate('trk_a', 27.6), candidate('trk_b', 22.1)], ['trk_a', 'trk_b'], []);
    expect(line).toBe('50s of footage followed.');
  });

  it('says when a selection has no preview rather than quietly dropping it', () => {
    // The old line summed the visible ones and said nothing, which is how "30
    // selected" sat next to "89s" with no way to reconcile the two.
    const line = coverageOf([candidate('trk_a', 89)], ['trk_a', 'trk_ghost'], []);
    expect(line).toContain('89s of footage followed');
    expect(line).toContain('1 more selected with no preview frame');
  });

  it('splits the seconds by upload when there is more than one', () => {
    const line = coverageOf(
      [candidate('trk_a', 89), candidate('trk_b', 11, 'vid_clip')],
      ['trk_a', 'trk_b'],
      videos,
    );
    expect(line).toBe('100s of footage followed (11s in output2.mp4, 89s in input.webm).');
  });

  it('stays quiet about videos nothing is selected in', () => {
    const line = coverageOf([candidate('trk_a', 89)], ['trk_a'], videos);
    expect(line).toBe('89s of footage followed (89s in input.webm).');
  });

  it('reads as empty before anything is picked', () => {
    expect(coverageOf([candidate('trk_a', 89)], [], videos)).toBe('Nothing selected yet.');
  });
});
