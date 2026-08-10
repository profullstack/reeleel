#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { Command } from 'commander';

import { closeDatabases, isReelEelError } from '@reeleel/core';

import { registerAnalyzeCommands } from './commands/analyze.js';
import { registerAthleteCommands } from './commands/athletes.js';
import { registerDataCommands } from './commands/data.js';
import { registerEditCommands } from './commands/edit.js';
import { registerMediaCommands } from './commands/media.js';
import { registerProjectCommands } from './commands/project.js';
import { registerSystemCommands } from './commands/system.js';
import { configureOutput, fail } from './output.js';

const VERSION = '0.3.0';

export const buildProgram = (): Command => {
  const program = new Command();

  program
    .name('reeleel')
    .description(
      'ReelEel — local-first youth-sports video intelligence.\n' +
        'Import a game, point at your athlete, get a highlight reel. Nothing leaves your machine.',
    )
    .version(VERSION, '-v, --version')
    .option('-p, --project <ref>', 'project path, id or name (default: the project you are inside)')
    .option('--json', 'machine-readable output', false)
    .option('-q, --quiet', 'suppress non-essential output', false)
    .option('--no-color', 'disable colored output')
    .enablePositionalOptions()
    .showHelpAfterError('(run `reeleel --help` for usage)');

  // Applied before any action runs so every command honours --json/--quiet.
  program.hook('preAction', (thisCommand) => {
    const options = thisCommand.opts() as { json?: boolean; quiet?: boolean };
    configureOutput({ json: options.json === true, quiet: options.quiet === true });
  });

  registerProjectCommands(program);
  registerMediaCommands(program);
  registerAthleteCommands(program);
  registerAnalyzeCommands(program);
  registerEditCommands(program);
  registerDataCommands(program);
  registerSystemCommands(program);

  program.addHelpText(
    'after',
    `
Examples:
  reeleel project create "Spring Cup QF" --sport soccer
  reeleel import ~/Videos/game.mp4
  reeleel athlete add --name "Sam" --number 7 --focal
  reeleel analyze --preset fast
  reeleel moments list
  reeleel moments update 3 --include
  reeleel clips from-moments
  reeleel reel create highlights --aspect 9:16
  reeleel export --reel highlights

Most subcommands accept the aliases you would expect:
  list -> ls        update -> set, edit        remove -> rm, delete, del
`,
  );

  return program;
};

const main = async (): Promise<void> => {
  const program = buildProgram();
  try {
    await program.parseAsync(process.argv);
  } catch (error) {
    // Commander throws for --help/--version; those are not failures.
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      typeof (error as { code?: unknown }).code === 'string' &&
      (error as { code: string }).code.startsWith('commander.')
    ) {
      return;
    }
    fail(error);
  } finally {
    closeDatabases();
  }
};

/** True when this file is the process entry point, false when imported by tests. */
const isEntryPoint = (): boolean => {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
};

if (isEntryPoint()) await main();

export { isReelEelError, main };
