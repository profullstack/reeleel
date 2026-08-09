import type { Command } from 'commander';

import { resolveProjectRoot, touchProject } from '@reeleel/core';

/**
 * Resolves which project a command should act on.
 *
 * Precedence: an explicit positional argument, then `--project`, then
 * `$REELEEL_PROJECT`, then the nearest project directory walking up from cwd.
 * That last one is what makes `cd my-game && reeleel analyze` work.
 */
export const projectRoot = async (command: Command, positional?: string): Promise<string> => {
  const options = command.optsWithGlobals() as { project?: string };
  const reference = positional ?? options.project ?? process.env['REELEEL_PROJECT'];
  const root = await resolveProjectRoot(reference);
  await touchProject(root);
  return root;
};

/** Parses `--tag a --tag b` or `--tag a,b` into a clean list. */
export const collect = (value: string, previous: string[] = []): string[] => [
  ...previous,
  ...value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0),
];

export const parseNumber =
  (label: string) =>
  (value: string): number => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      throw new Error(`${label} must be a number, got "${value}".`);
    }
    return parsed;
  };

/**
 * Commander gives `--no-x` flags a default of true, which makes "was it passed?"
 * ambiguous. This reads raw argv instead, so we can tell "left alone" apart from
 * "explicitly disabled".
 */
export const flagWasGiven = (flag: string): boolean => process.argv.includes(flag);
