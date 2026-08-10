import { describe, expect, it } from 'vitest';

import { describeAthlete } from './athletes.js';
import type { Athlete } from './types.js';

/**
 * "#14 on white, not #14 on black."
 *
 * A jersey number does not identify a child — both teams have a 14, and on a
 * school court they are regularly on screen together. The shirt colour is the
 * part a parent actually uses to point, and `jersey_color` has been on the
 * athlete row since the first migration with nothing ever writing or showing
 * it. So the picker could only offer names, which is the one attribute a
 * detector cannot help you match against.
 */

const athlete = (over: Partial<Athlete> = {}): Athlete =>
  ({
    id: 'ath_test',
    projectId: 'prj_test',
    name: null,
    jerseyNumber: null,
    team: null,
    jerseyColor: null,
    focalTrackId: null,
    isFocal: false,
    createdAt: '',
    updatedAt: '',
    ...over,
  }) as Athlete;

describe('naming an athlete the way a parent would', () => {
  it('says which shirt, so two number 14s are distinguishable', () => {
    const white = describeAthlete(athlete({ jerseyNumber: '14', jerseyColor: 'white' }));
    const black = describeAthlete(athlete({ jerseyNumber: '14', jerseyColor: 'black' }));
    expect(white).toBe('#14 in white');
    expect(black).toBe('#14 in black');
    expect(white).not.toBe(black);
  });

  it('reads naturally with everything filled in', () => {
    expect(
      describeAthlete(
        athlete({ name: 'Fred', jerseyNumber: '14', jerseyColor: 'white', team: 'Triton' }),
      ),
    ).toBe('Fred #14 in white (Triton)');
  });

  it('still works with only a name, which is all it used to have', () => {
    expect(describeAthlete(athlete({ name: 'Fred' }))).toBe('Fred');
  });

  it('falls back to the id rather than an empty label', () => {
    expect(describeAthlete(athlete())).toBe('ath_test');
  });
});
