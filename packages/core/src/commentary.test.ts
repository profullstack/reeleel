import { describe, expect, it } from 'vitest';

import { templateLine, templateScript } from './commentary.js';
import type { Clip, SuggestedMoment } from './types.js';

/**
 * The announcer's one unrecoverable failure is inventing a moment that did not
 * happen. The parent was at the game; a line claiming a basket that was really
 * a missed shot is worse than no commentary at all.
 *
 * Nothing in this system knows whether a shot went in. Detection knows a ball
 * was near a player. So the template says only that, and the title — the one
 * thing a human wrote — always wins.
 */

const moment = (over: Partial<SuggestedMoment> = {}): SuggestedMoment =>
  ({
    id: 'mom_1',
    projectId: 'prj_1',
    videoId: 'vid_1',
    athleteId: null,
    start: 142,
    end: 147,
    score: 0.55,
    reasons: [],
    included: true,
    favorite: false,
    manual: false,
    title: null,
    createdAt: '',
    updatedAt: '',
    ...over,
  }) as SuggestedMoment;

const clip = (over: Partial<Clip> = {}): Clip =>
  ({
    id: 'clp_1',
    projectId: 'prj_1',
    momentId: 'mom_1',
    videoId: 'vid_1',
    start: 142,
    end: 147,
    order: 0,
    cameraMode: 'follow-player',
    title: null,
    manual: false,
    renderedPath: null,
    createdAt: '',
    updatedAt: '',
    ...over,
  }) as Clip;

const context = { athleteName: 'Sam', sport: 'basketball', projectName: 'Game' };

describe('what the announcer is allowed to say', () => {
  it('uses the title verbatim when a human wrote one', () => {
    const line = templateLine(moment({ title: 'Sam steals it at half court' }), context, 0);
    expect(line).toBe('Sam steals it at half court');
  });

  it('claims a possession, never a basket, from ball proximity', () => {
    const line = templateLine(moment({ reasons: ['player_ball_proximity'] }), context, 0);
    expect(line).toContain('Sam');
    // The words that would be a lie: nothing here knows a shot went in.
    expect(line).not.toMatch(/scores?|basket|shot|point|nails|drains/i);
  });

  it('says something plain rather than nothing when no signal is strong', () => {
    const line = templateLine(moment({ reasons: [] }), context, 2);
    expect(line.length).toBeGreaterThan(0);
    expect(line).toContain('3');
  });

  it('falls back to a generic name when no athlete is identified', () => {
    const line = templateLine(moment({ reasons: ['player_ball_proximity'] }), {
      ...context,
      athleteName: null,
    }, 0);
    expect(line).toContain('our player');
    expect(line).not.toContain('null');
  });
});

describe('scheduling the lines across a reel', () => {
  it('places each line inside its own clip, in order', () => {
    const clips = [
      clip({ id: 'a', start: 10, end: 15 }),
      clip({ id: 'b', momentId: 'mom_2', start: 40, end: 46 }),
    ];
    const lines = templateScript(clips, [moment()], context);
    expect(lines.map((line) => line.clipId)).toEqual(['a', 'b']);
    // First clip is five seconds, so the second line starts after it.
    expect(lines[0]!.startSeconds).toBeGreaterThan(0);
    expect(lines[0]!.startSeconds).toBeLessThan(5);
    expect(lines[1]!.startSeconds).toBeGreaterThanOrEqual(5);
  });

  it('does not start a line on the very first frame', () => {
    // Otherwise the announcer talks over the fade-in.
    const lines = templateScript([clip()], [moment()], context);
    expect(lines[0]!.startSeconds).toBeGreaterThan(0);
  });

  it('marks which lines came from a human, so the log can say so', () => {
    const lines = templateScript(
      [clip(), clip({ id: 'clp_2', momentId: 'mom_2' })],
      [moment({ title: 'Sam steals it' }), moment({ id: 'mom_2' })],
      context,
    );
    expect(lines[0]!.fromTitle).toBe(true);
    expect(lines[1]!.fromTitle).toBe(false);
  });

  it('produces nothing for a reel with no clips', () => {
    expect(templateScript([], [], context)).toEqual([]);
  });
});
