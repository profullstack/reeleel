import { describe, expect, it } from 'vitest';

import {
  JERSEY_FLOOR,
  chooseAthleteTracks,
  jerseyMass,
  similarity,
} from './stitch.js';
import type { TrackSeries } from './scoring.js';

/**
 * "It followed #14 on the black team, not the white team."
 *
 * Both teams field a 14, and the number is the half of "#14 in white" that no
 * detector can check. `jersey_color` has been on the athlete row since the first
 * migration and nothing but a label has ever read it, so the matcher was told a
 * shirt and then went looking without it.
 *
 * Colour did exist in the matcher, but only as agreement with a running average
 * that is re-derived after every acceptance so it can follow the athlete's own
 * lighting down the court. That average can be walked, one admissible step at a
 * time, toward a shirt the athlete never wore — and the link gap that makes the
 * walk possible was widened from two seconds to six to recover coverage. An
 * absolute bar cannot be walked.
 */

const BINS = 28;
const hist = (parts: Record<number, number>): number[] => {
  const out = new Array<number>(BINS).fill(0);
  for (const [bin, value] of Object.entries(parts)) out[Number(bin)] = value;
  const total = out.reduce((sum, value) => sum + value, 0);
  return out.map((value) => value / total);
};

/** Bin 27 is the brightest lightness bin, 24 the darkest; 2 is skin, 5 the floor. */
const WHITE = hist({ 27: 0.62, 26: 0.1, 2: 0.13, 5: 0.15 });
const BLACK = hist({ 24: 0.6, 25: 0.08, 2: 0.13, 5: 0.15 });

const track = (id: string, from: number, to: number, x: number): TrackSeries => ({
  id,
  className: 'player',
  samples: Array.from({ length: Math.round((to - from) * 30) + 1 }, (_unused, i) => ({
    ts: Number((from + i / 30).toFixed(3)),
    x,
    y: 400,
    w: 70,
    h: 170,
    confidence: 0.9,
  })),
});

describe('which #14', () => {
  it('reads a shirt as a share of the torso, and the other team as none of it', () => {
    expect(jerseyMass(WHITE, 'white')).toBeGreaterThan(JERSEY_FLOOR);
    expect(jerseyMass(BLACK, 'black')).toBeGreaterThan(JERSEY_FLOOR);
    expect(jerseyMass(BLACK, 'white')).toBeLessThan(JERSEY_FLOOR);
    expect(jerseyMass(WHITE, 'black')).toBeLessThan(JERSEY_FLOOR);
  });

  it('is case and whitespace insensitive, because a person typed it', () => {
    expect(jerseyMass(WHITE, '  White ')).toBe(jerseyMass(WHITE, 'white'));
  });

  it('judges nothing it has no bins for, rather than rejecting everything', () => {
    // The failure to avoid is a project where somebody typed "sky blue" and the
    // matcher silently stopped proposing anybody at all.
    expect(jerseyMass(WHITE, 'chartreuse')).toBeNull();
    expect(jerseyMass(WHITE, null)).toBeNull();
    expect(jerseyMass(WHITE, undefined)).toBeNull();
  });

  /**
   * The relative floor is what the matcher shipped with, and it is not nothing:
   * white against black intersects at 0.28. But the floor is a tunable that has
   * already been pushed downward once to recover coverage, and every step down
   * buys the other team a way in.
   */
  it('lets the other team through on continuity alone once the floor is loosened', () => {
    expect(similarity(WHITE, BLACK)).toBeLessThan(0.7);

    const accepted = chooseAthleteTracks({
      reference: [track('ref_white', 0, 4, 500)],
      candidates: [track('black14', 4.5, 8, 620)],
      signatures: { ref_white: WHITE, black14: BLACK },
      pixels: { ref_white: 4000, black14: 6000 },
      frameWidth: 1920,
      threshold: 0.25,
    });
    expect(accepted.map((proposal) => proposal.trackId)).toEqual(['black14']);
  });

  it('refuses it outright once the shirt is declared, however good the link', () => {
    const accepted = chooseAthleteTracks({
      reference: [track('ref_white', 0, 4, 500)],
      candidates: [track('black14', 4.5, 8, 620)],
      signatures: { ref_white: WHITE, black14: BLACK },
      pixels: { ref_white: 4000, black14: 6000 },
      frameWidth: 1920,
      threshold: 0.25,
      jerseyColor: 'white',
    });
    expect(accepted).toEqual([]);
  });

  it('still takes the athlete’s own team-mate-free fragments', () => {
    const accepted = chooseAthleteTracks({
      reference: [track('ref_white', 0, 4, 500)],
      candidates: [track('white_again', 4.5, 8, 620)],
      signatures: { ref_white: WHITE, white_again: WHITE },
      pixels: { ref_white: 4000, white_again: 6000 },
      frameWidth: 1920,
      jerseyColor: 'white',
    });
    expect(accepted.map((proposal) => proposal.trackId)).toEqual(['white_again']);
  });

  it('changes nothing for a project that never recorded a colour', () => {
    const withoutColour = chooseAthleteTracks({
      reference: [track('ref_white', 0, 4, 500)],
      candidates: [track('black14', 4.5, 8, 620)],
      signatures: { ref_white: WHITE, black14: BLACK },
      pixels: { ref_white: 4000, black14: 6000 },
      frameWidth: 1920,
      threshold: 0.25,
    });
    const withNull = chooseAthleteTracks({
      reference: [track('ref_white', 0, 4, 500)],
      candidates: [track('black14', 4.5, 8, 620)],
      signatures: { ref_white: WHITE, black14: BLACK },
      pixels: { ref_white: 4000, black14: 6000 },
      frameWidth: 1920,
      threshold: 0.25,
      jerseyColor: null,
    });
    expect(withNull).toEqual(withoutColour);
  });
});
