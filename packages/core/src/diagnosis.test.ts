import { describe, expect, it } from 'vitest';

import { getSport } from '@reeleel/sports';

import { explainScoring } from './scoring.js';
import type { ScoringInput, TrackSeries } from './scoring.js';

/**
 * A run that produces nothing has to be able to say why.
 *
 * "Tracks were found but none scored above the threshold" was true of a real
 * user's 1525-track run and told them nothing: it reads as "your footage was
 * dull", when in fact no footage whatsoever could have cleared the threshold
 * with no athlete identified. The number that distinguishes those is the
 * ceiling, so the ceiling is what these tests pin down.
 */

const DURATION = 150;
const plugin = getSport('basketball')!;

const samples = (fn: (ts: number) => { x: number; y: number; w: number; h: number }) =>
  Array.from({ length: DURATION + 1 }, (_unused, ts) => ({ ts, ...fn(ts), confidence: 0.9 }));

const player = (id: string): TrackSeries => ({
  id,
  className: 'player',
  samples: samples((ts) => ({ x: 100 + ((ts * 11) % 700), y: 300, w: 40, h: 100 })),
});

const ball: TrackSeries = {
  id: 'trk_ball',
  className: 'ball',
  samples: samples((ts) => ({
    x: ts >= 40 && ts <= 70 ? 100 + ((ts * 11) % 700) + 25 : 900,
    y: ts >= 40 && ts <= 70 ? 315 : 60,
    w: 18,
    h: 18,
  })),
};

const input = (focalTrackId: string | null, tracks: TrackSeries[]): ScoringInput => ({
  durationSeconds: DURATION,
  frameWidth: 960,
  frameHeight: 540,
  focalTrackId,
  tracks,
});

describe('explaining why a run scored what it did', () => {
  it('reports the threshold as unreachable when no athlete is identified', () => {
    // The user's actual situation, and the one the old message described wrongly.
    const diagnosis = explainScoring(input(null, [player('trk_a'), player('trk_b'), ball]), plugin);
    expect(diagnosis.reachable).toBe(false);
    expect(diagnosis.ceiling).toBeLessThan(diagnosis.threshold);
    expect(diagnosis.focalBound).toBe(false);
    // A ball being present must not change this: without a focal track the ball
    // signals have nothing to measure against.
    expect(diagnosis.measurable).toEqual(['high_motion']);
  });

  it('becomes reachable once an athlete is identified', () => {
    const diagnosis = explainScoring(
      input('trk_a', [player('trk_a'), player('trk_b'), ball]),
      plugin,
    );
    expect(diagnosis.reachable).toBe(true);
    expect(diagnosis.focalBound).toBe(true);
    expect(diagnosis.bestScore).toBeGreaterThan(diagnosis.threshold);
  });

  it('names the signals that had no data, so the gap is nameable', () => {
    const diagnosis = explainScoring(input('trk_a', [player('trk_a')]), plugin);
    // No hoop, no audio, no ball in this footage.
    expect(diagnosis.unmeasurable).toContain('toward_goal');
    expect(diagnosis.unmeasurable).toContain('audio_spike');
    expect(diagnosis.unmeasurable).toContain('player_ball_proximity');
  });

  it('counts tracks by class and measures the longest, to expose fragmentation', () => {
    const short: TrackSeries = {
      id: 'trk_short',
      className: 'player',
      samples: [
        { ts: 10, x: 0, y: 0, w: 10, h: 10, confidence: 0.9 },
        { ts: 11, x: 1, y: 0, w: 10, h: 10, confidence: 0.9 },
      ],
    };
    const diagnosis = explainScoring(input('trk_a', [player('trk_a'), ball, short]), plugin);
    expect(diagnosis.tracksByClass).toEqual({ player: 2, ball: 1 });
    expect(diagnosis.longestTrackSeconds).toBe(DURATION);
  });

  it('reports a zero ceiling rather than crashing when there is nothing at all', () => {
    const diagnosis = explainScoring(input(null, []), plugin);
    expect(diagnosis.ceiling).toBe(0);
    expect(diagnosis.reachable).toBe(false);
    expect(diagnosis.longestTrackSeconds).toBe(0);
  });
});
