import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

/**
 * `curl -fsSL https://reeleel.com/install.sh | sh` pipes this file straight into
 * a shell, so it has to be a script (not the page shell), install the package
 * that is actually on npm, and never reach for sudo.
 */
const script = readFileSync(new URL('../public/install.sh', import.meta.url), 'utf8');
const cliPackage = JSON.parse(
  readFileSync(new URL('../../cli/package.json', import.meta.url), 'utf8'),
) as { name: string; bin: Record<string, string> };

describe('the CLI installer', () => {
  it('is a POSIX shell script', () => {
    expect(script.startsWith('#!/bin/sh\n')).toBe(true);
    expect(script).toContain('set -eu');
  });

  it('installs the published CLI package and checks for its bin', () => {
    expect(script).toContain(`PKG="${cliPackage.name}"`);
    expect(Object.keys(cliPackage.bin)).toContain('reeleel');
    expect(script).toContain('have reeleel');
  });

  it('never asks for root', () => {
    const code = script
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'))
      .join('\n');
    expect(code).not.toContain('sudo');
  });
});
