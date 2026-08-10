import { describe, expect, it } from 'vitest';

import { CANVAS_STYLE, CONTROL_STRIP, HIT_STYLE } from './client/review.js';

/**
 * The review page could not be played.
 *
 * Boxes are drawn on a canvas stretched over the whole video, which includes
 * the play button and the scrubber. The first version made that canvas
 * clickable so a player could be selected by pointing at them — and in doing so
 * covered the control that starts playback. Reported as "i can't click play i
 * just have cross hairs".
 *
 * Nothing about that failure is visible in a screenshot or a type: the page
 * renders perfectly and simply does not respond. So the two style rules that
 * keep it working are asserted here rather than left as a comment.
 */

describe('the review overlay never swallows the player controls', () => {
  it('leaves the drawing canvas transparent to the pointer', () => {
    expect(CANVAS_STYLE).toContain('pointer-events:none');
  });

  it('keeps the canvas exactly the size of the video', () => {
    // Any inset would put every box in the wrong place, since the drawing
    // scale is computed from the video's own dimensions.
    expect(CANVAS_STYLE).toContain('inset:0');
    expect(CANVAS_STYLE).toContain('width:100%');
    expect(CANVAS_STYLE).toContain('height:100%');
  });

  it('stops the click layer above the controls', () => {
    expect(HIT_STYLE).toContain(`bottom:${CONTROL_STRIP}`);
    expect(HIT_STYLE).not.toContain('bottom:0');
  });

  it('hides the click layer until identifying is asked for', () => {
    // Otherwise it covers the video permanently, which is the original bug
    // wearing a different hat.
    expect(HIT_STYLE).toContain('display:none');
  });

  it('reserves a real amount of room, not a token one', () => {
    expect(Number.parseFloat(CONTROL_STRIP)).toBeGreaterThanOrEqual(2);
  });
});
