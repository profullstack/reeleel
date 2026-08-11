import { SUPPORTED_EXTENSIONS } from '@reeleel/core';
import { describe, expect, it } from 'vitest';

import { FILE_INPUT_ACCEPT } from './accept.js';

/**
 * The picker filter and the server's allowlist are two copies of one fact, kept
 * apart only because this module has to survive being bundled for the browser.
 * If they drift, a file the server would happily import becomes unselectable —
 * which is the exact bug this list was widened to fix.
 */
describe('FILE_INPUT_ACCEPT', () => {
  const entries = FILE_INPUT_ACCEPT.split(',');

  it('offers every container the server will accept', () => {
    const missing = SUPPORTED_EXTENSIONS.filter((ext) => !entries.includes(ext));
    expect(missing).toEqual([]);
  });

  it('claims no extension the server would reject', () => {
    const extras = entries
      .filter((entry) => entry.startsWith('.'))
      .filter((entry) => !(SUPPORTED_EXTENSIONS as readonly string[]).includes(entry));
    expect(extras).toEqual([]);
  });

  it('leads with extensions, so no platform mime lookup is required', () => {
    expect(entries[0]).toBe('.mp4');
    expect(entries).toContain('.webm');
  });
});
