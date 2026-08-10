import { describe, expect, it } from 'vitest';

import { PRESET_SETTINGS, settingsForPreset } from './analyze.js';
import { PRESETS } from './types.js';

/**
 * `thorough` slices each frame so the detector can resolve the ball. Measured
 * end to end on a 40-second slice of real footage: 3 ball tracks covering 0.3
 * seconds became 14 covering 2.8, for 5.2x the runtime. It is a separate preset
 * rather than a change to `balanced` because that cost belongs to whoever
 * chooses to pay it.
 */

describe('analysis presets', () => {
  it('offers tiling only where the cost has been accepted', () => {
    expect(PRESET_SETTINGS.fast.tileGrid).toBe(1);
    expect(PRESET_SETTINGS.balanced.tileGrid).toBe(1);
    expect(PRESET_SETTINGS.accurate.tileGrid).toBe(1);
    expect(PRESET_SETTINGS.thorough.tileGrid).toBeGreaterThan(1);
  });

  it('is listed, so it can actually be picked', () => {
    expect(PRESETS).toContain('thorough');
  });

  it('gives every named preset settings', () => {
    for (const preset of PRESETS) {
      const settings = settingsForPreset(preset);
      expect(settings.frameStride).toBeGreaterThan(0);
      expect(settings.tileGrid).toBeGreaterThanOrEqual(1);
    }
  });

  /**
   * The web form and the API cast an arbitrary string into `Preset`, so this is
   * reachable from a hand-crafted post rather than only from a typo in code.
   */
  it('falls back rather than crashing on a preset that does not exist', () => {
    const settings = settingsForPreset('nonsense' as never);
    expect(settings).toEqual(PRESET_SETTINGS.balanced);
  });
});
