import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SPORT,
  PLANNED_SPORTS,
  getSport,
  isKnownSport,
  listSports,
  requiredClasses,
} from './index.js';

const EXPECTED = [
  'soccer',
  'basketball',
  'baseball',
  'softball',
  'hockey',
  'lacrosse',
  'football',
  'volleyball',
];

describe('registry', () => {
  it('ships every youth sport on the PRD roadmap', () => {
    const ids = listSports().map((sport) => sport.id);
    for (const sport of EXPECTED) expect(ids).toContain(sport);
  });

  it('defaults to soccer, the first supported sport', () => {
    expect(DEFAULT_SPORT).toBe('soccer');
    expect(isKnownSport(DEFAULT_SPORT)).toBe(true);
  });

  it('rejects a sport with no definition', () => {
    expect(isKnownSport('quidditch')).toBe(false);
    expect(getSport('quidditch')).toBeNull();
  });

  it('does not list a planned sport as installed', () => {
    for (const planned of PLANNED_SPORTS) expect(isKnownSport(planned)).toBe(false);
  });

  it('sorts by display name so a picker reads sensibly', () => {
    const names = listSports().map((sport) => sport.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });
});

describe('every sport definition', () => {
  for (const id of EXPECTED) {
    describe(id, () => {
      const sport = getSport(id);

      it('exists and is internally consistent', () => {
        expect(sport).not.toBeNull();
        expect(sport?.id).toBe(id);
        expect(sport?.name.length).toBeGreaterThan(0);
      });

      it('always includes a player class', () => {
        // The focal athlete is the entire premise of the product.
        expect(requiredClasses(sport!)).toContain('player');
      });

      it('has no duplicate class names', () => {
        const names = sport!.classes.map((c) => c.name);
        expect(new Set(names).size).toBe(names.length);
      });

      it('gives the scorer a usable set of weighted rules', () => {
        const rules = sport!.moments.rules;
        expect(rules.length).toBeGreaterThan(0);
        expect(rules.every((rule) => rule.weight > 0)).toBe(true);
        // A user-marked moment must always outrank anything inferred.
        expect(rules.find((rule) => rule.id === 'user_marker')?.weight).toBe(1);
      });

      it('defines a sane clip window', () => {
        const { minDurationSeconds, maxDurationSeconds, preRollSeconds, postRollSeconds } =
          sport!.moments;
        expect(minDurationSeconds).toBeGreaterThan(0);
        expect(maxDurationSeconds).toBeGreaterThan(minDurationSeconds);
        expect(preRollSeconds).toBeGreaterThanOrEqual(0);
        expect(postRollSeconds).toBeGreaterThanOrEqual(0);
      });

      it('configures a tracker', () => {
        expect(sport!.tracker.algorithm).toBe('bytetrack');
        expect(sport!.tracker.minConfidence).toBeGreaterThan(0);
        expect(sport!.tracker.minConfidence).toBeLessThan(1);
      });

      it('names its target in the terminology and the rules', () => {
        const target = sport!.terms['target'];
        expect(target).toBeDefined();
        // The scorer's label should speak the sport's language, not soccer's.
        const towardGoal = sport!.moments.rules.find((rule) => rule.id === 'toward_goal');
        expect(towardGoal?.label.toLowerCase()).toContain((target as string).toLowerCase());
      });
    });
  }
});

describe('sport-specific shape', () => {
  it('uses court and basket language for basketball', () => {
    const basketball = getSport('basketball');
    expect(basketball?.terms['field']).toBe('court');
    expect(basketball?.terms['period']).toBe('quarter');
    expect(requiredClasses(basketball!)).toContain('hoop');
  });

  it('gives baseball a bat and a glove', () => {
    const classes = requiredClasses(getSport('baseball')!);
    expect(classes).toContain('bat');
    expect(classes).toContain('glove');
  });

  it('tracks a puck rather than a ball in hockey, with a looser confidence floor', () => {
    const hockey = getSport('hockey');
    expect(requiredClasses(hockey!)).toContain('puck');
    expect(requiredClasses(hockey!)).not.toContain('ball');
    // A small, fast puck is detected less confidently than a soccer ball.
    expect(hockey!.tracker.minConfidence).toBeLessThan(getSport('soccer')!.tracker.minConfidence);
  });

  it('gives basketball a shorter play window than baseball', () => {
    // Possessions versus at-bats: the clip lengths should not be identical.
    expect(getSport('basketball')!.moments.maxDurationSeconds).toBeLessThan(
      getSport('baseball')!.moments.maxDurationSeconds,
    );
  });

  it('keeps soccer exactly as the PRD specifies', () => {
    const classes = requiredClasses(getSport('soccer')!);
    for (const required of ['player', 'ball', 'referee', 'goalkeeper', 'goal']) {
      expect(classes).toContain(required);
    }
  });
});
