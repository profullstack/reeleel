import { describe, expect, it } from 'vitest';

import { parseByteRange } from './range.js';

describe('byte ranges', () => {
  it('leaves absent and unsupported range headers alone', () => {
    expect(parseByteRange(undefined, 1_000)).toEqual({ kind: 'none' });
    expect(parseByteRange('items=0-10', 1_000)).toEqual({ kind: 'none' });
  });

  it('parses bounded and open-ended ranges', () => {
    expect(parseByteRange('bytes=100-199', 1_000)).toEqual({
      kind: 'range',
      start: 100,
      end: 199,
    });
    expect(parseByteRange('bytes=100-', 1_000)).toEqual({
      kind: 'range',
      start: 100,
      end: 999,
    });
  });

  it('serves suffix ranges from the end of the file', () => {
    expect(parseByteRange('bytes=-500', 1_000)).toEqual({
      kind: 'range',
      start: 500,
      end: 999,
    });
    expect(parseByteRange('bytes=-2000', 1_000)).toEqual({
      kind: 'range',
      start: 0,
      end: 999,
    });
  });

  it('rejects syntactically valid but unsatisfiable ranges', () => {
    expect(parseByteRange('bytes=-', 1_000)).toEqual({ kind: 'invalid' });
    expect(parseByteRange('bytes=-0', 1_000)).toEqual({ kind: 'invalid' });
    expect(parseByteRange('bytes=1000-', 1_000)).toEqual({ kind: 'invalid' });
    expect(parseByteRange('bytes=200-100', 1_000)).toEqual({ kind: 'invalid' });
  });
});
