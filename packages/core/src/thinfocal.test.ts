import { describe, expect, it } from 'vitest';

import { getSport } from '@reeleel/sports';

import { detectionInputFor, PRESET_SETTINGS } from './analyze.js';
import { computeMoments, explainScoring, SIGNALS, buildContext } from './scoring.js';
import type { ScoringInput, TrackSeries } from './scoring.js';

/**
 * The shape of a real run that suggested nothing, and reported every reason but
 * the true one.
 *
 * Production: a five-minute basketball game, 1,415 tracks, a rim seen for 28s, a
 * ball seen for 23s — and a focal athlete bound to a ten-frame fragment lasting
 * 0.3s. Every line the user was shown read plausibly ("tracks found", "athlete
 * identified: yes", "highest reachable 1.000", "none scored above 0.35"), which
 * together say "your footage was dull". The footage was fine. These tests pin
 * the arithmetic that made those lines wrong.
 */

const DURATION = 300;
const plugin = getSport('basketball')!;
const FPS = 30;

/** Dense samples over a span, the way the tracker actually emits them. */
const spanSamples = (
  from: number,
  to: number,
  fn: (ts: number) => { x: number; y: number; w: number; h: number },
) => {
  const out = [];
  for (let ts = from; ts <= to; ts += 1 / FPS) {
    out.push({ ts: Number(ts.toFixed(3)), ...fn(ts), confidence: 0.9 });
  }
  return out;
};

const wanderingPlayer = (id: string, from: number, to: number, offset = 0): TrackSeries => ({
  id,
  className: 'player',
  samples: spanSamples(from, to, (ts) => ({
    x: 200 + offset + Math.sin(ts) * 300,
    y: 500 + Math.cos(ts * 0.7) * 120,
    w: 60,
    h: 150,
  })),
});

const hoop: TrackSeries = {
  id: 'trk_hoop',
  className: 'hoop',
  samples: spanSamples(0, 28, () => ({ x: 1500, y: 200, w: 80, h: 60 })),
};

const input = (focalTrackIds: string[], tracks: TrackSeries[]): ScoringInput => ({
  durationSeconds: DURATION,
  frameWidth: 1920,
  frameHeight: 1080,
  focalTrackId: focalTrackIds[0] ?? null,
  focalTrackIds,
  tracks,
});

describe('an athlete bound to a sliver of the game', () => {
  /** The production binding: 10 frames, ts 0 → 0.3, of a 300s video. */
  const sliver: TrackSeries = {
    id: 'trk_sliver',
    className: 'player',
    samples: spanSamples(0, 0.3, () => ({ x: 400, y: 500, w: 60, h: 150 })),
  };
  const crowd = [
    wanderingPlayer('trk_a', 0, 300),
    wanderingPlayer('trk_b', 0, 300, 400),
    wanderingPlayer('trk_c', 219, 251, 800),
  ];

  it('reports how little of the game the athlete is actually on screen for', () => {
    const diagnosis = explainScoring(input(['trk_sliver'], [sliver, ...crowd, hoop]), plugin);

    expect(diagnosis.focalBound).toBe(true);
    // The number that was missing. "Identified: yes" was true and useless.
    expect(diagnosis.focalSeconds).toBeLessThan(1);
    expect(diagnosis.durationSeconds).toBe(300);
    expect(diagnosis.focalTrackCount).toBe(1);
  });

  it('does not count athlete signals as measurable when the athlete is absent', () => {
    const diagnosis = explainScoring(input(['trk_sliver'], [sliver, ...crowd, hoop]), plugin);

    /**
     * `player_acceleration` and `toward_goal` used to return 0 rather than null
     * whenever the athlete had no position, which is 99.9% of this footage.
     * That made them "measurable", kept 0.35 of weight in every denominator,
     * and pushed the reported ceiling to 1.000 — telling the user a threshold
     * was reachable that arithmetically was not.
     */
    expect(diagnosis.unmeasurable).toContain('player_acceleration');
    expect(diagnosis.unmeasurable).toContain('toward_goal');
    expect(diagnosis.unmeasurable).toContain('player_ball_proximity');
    expect(diagnosis.ceiling).toBeLessThan(1);
  });

  it('suggests nothing, because nothing can be measured about the athlete', () => {
    expect(computeMoments(input(['trk_sliver'], [sliver, ...crowd, hoop]), plugin)).toEqual([]);
  });
});

describe('signals that cannot see the athlete', () => {
  const present: TrackSeries = {
    id: 'trk_focal',
    className: 'player',
    samples: spanSamples(100, 130, (ts) => ({
      x: 400 + (ts - 100) * 30,
      y: 500,
      w: 60,
      h: 150,
    })),
  };
  const context = buildContext(
    input(['trk_focal'], [present, wanderingPlayer('trk_x', 0, 300), hoop]),
    plugin.targetClass,
  );

  it('returns null, not zero, for acceleration outside the athlete’s span', () => {
    // Off screen is unmeasured; zero would mean "measured, standing still".
    expect(SIGNALS['player_acceleration']?.(context, 200)).toBeNull();
    expect(SIGNALS['player_acceleration']?.(context, 115)).not.toBeNull();
  });

  it('returns null for toward-goal when the athlete or the rim is not in frame', () => {
    // Athlete present (100–130) but the rim is only tracked over 0–28.
    expect(SIGNALS['toward_goal']?.(context, 115)).toBeNull();
    // Athlete absent entirely.
    expect(SIGNALS['toward_goal']?.(context, 250)).toBeNull();
  });

  it('returns null for activity near the goal when no rim is in frame', () => {
    expect(SIGNALS['activity_near_goal']?.(context, 200)).toBeNull();
    expect(SIGNALS['activity_near_goal']?.(context, 10)).not.toBeNull();
  });
});

describe('choosing what the detector reads', () => {
  const video = { path: '/p/source/game.mp4', proxyPath: '/p/proxies/vid_540p.mp4' };

  it('skips a proxy smaller than the size the preset detects at', () => {
    // balanced asks for 768 against a 540p proxy: upscaling, for no saving but
    // decode time. This is what cost the production run 78,000 detections.
    const choice = detectionInputFor(PRESET_SETTINGS.balanced, video, true);
    expect(choice.input).toBe(video.path);
    expect(choice.usedProxy).toBe(false);
    expect(choice.proxyTooSmall).toBe(true);
  });

  it('still uses the proxy when it is big enough for the preset', () => {
    const choice = detectionInputFor(PRESET_SETTINGS.fast, video, true);
    expect(choice.input).toBe(video.proxyPath);
    expect(choice.usedProxy).toBe(true);
    expect(choice.proxyTooSmall).toBe(false);
  });

  it('falls back to the source when the proxy does not exist yet', () => {
    expect(detectionInputFor(PRESET_SETTINGS.fast, video, false).input).toBe(video.path);
  });

  it('leaves presets that already read the original alone', () => {
    for (const preset of ['accurate', 'thorough'] as const) {
      const choice = detectionInputFor(PRESET_SETTINGS[preset], video, true);
      expect(choice.input).toBe(video.path);
      expect(choice.proxyTooSmall).toBe(false);
    }
  });
});
