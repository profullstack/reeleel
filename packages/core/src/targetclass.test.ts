import { describe, expect, it } from 'vitest';

import { getSport, listSports } from '@reeleel/sports';

import { buildContext, computeMoments } from './scoring.js';
import type { ScoringInput, TrackSeries } from './scoring.js';

/**
 * Scoring looked for a track called `goal` whatever the sport. Basketball
 * tracks a `hoop`, hockey a `net`, football an `end_zone` — so for those sports
 * the two target signals could never fire, even with a model that saw the thing
 * perfectly. Soccer worked by luck of naming.
 */

const series = (id: string, className: string, x: number): TrackSeries => ({
  id,
  className,
  samples: Array.from({ length: 11 }, (_unused, n) => ({
    ts: n,
    x,
    y: 100,
    w: 40,
    h: 40,
    confidence: 0.9,
  })),
});

const inputWith = (tracks: TrackSeries[]): ScoringInput => ({
  durationSeconds: 10,
  frameWidth: 1920,
  frameHeight: 1080,
  focalTrackId: null,
  tracks,
});

describe('the scoring target is named by the sport', () => {
  it('every sport that tracks its target resolves to a real class', () => {
    for (const listed of listSports()) {
      const plugin = getSport(listed.id);
      if (plugin === null || plugin.targetClass === null) continue;
      const names = plugin.classes.map((entry) => entry.name);
      expect(names, `${listed.id} declares targetClass "${plugin.targetClass}"`).toContain(
        plugin.targetClass,
      );
    }
  });

  it('resolves the ones that differ from the noun', () => {
    // The bug in one line: "basket" is the noun, "hoop" is the tracked thing.
    expect(getSport('basketball')?.targetClass).toBe('hoop');
    expect(getSport('football')?.targetClass).toBe('end_zone');
    expect(getSport('hockey')?.targetClass).toBe('net');
    expect(getSport('soccer')?.targetClass).toBe('goal');
  });

  it("finds basketball's hoop, which a hardcoded 'goal' never would", () => {
    const tracks = [series('t1', 'hoop', 500), series('t2', 'player', 520)];
    const context = buildContext(inputWith(tracks), getSport('basketball')?.targetClass ?? null);
    expect(context.goals).toHaveLength(1);
    expect(context.goals[0]?.className).toBe('hoop');
  });

  it('still finds a goal for the sports that call it that', () => {
    const tracks = [series('t1', 'goal', 500)];
    expect(buildContext(inputWith(tracks), 'goal').goals).toHaveLength(1);
  });

  it('treats a sport with no trackable target as having none, not as broken', () => {
    const tracks = [series('t1', 'player', 500)];
    expect(buildContext(inputWith(tracks), null).goals).toHaveLength(0);
  });

  it('does not mistake one sport\'s target for another\'s', () => {
    const tracks = [series('t1', 'hoop', 500)];
    // Scoring a basketball clip as soccer must not find a "goal".
    expect(buildContext(inputWith(tracks), 'goal').goals).toHaveLength(0);
  });

  it('scores without crashing when the target class is absent', () => {
    const plugin = getSport('basketball');
    const tracks = [series('t1', 'player', 500), series('t2', 'ball', 505)];
    expect(() => computeMoments(inputWith(tracks), plugin!)).not.toThrow();
  });
});
