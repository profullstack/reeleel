import { describe, expect, it } from 'vitest';

import type { Command } from 'commander';

import { buildProgram } from './index.js';

const find = (program: Command, name: string): Command | undefined =>
  program.commands.find((command) => command.name() === name);

const namesAndAliases = (command: Command): string[] => [command.name(), ...command.aliases()];

describe('command surface', () => {
  const program = buildProgram();

  it('exposes every workflow step from the PRD', () => {
    const top = program.commands.map((command) => command.name());
    for (const expected of [
      'project',
      'probe',
      'import',
      'athlete',
      'analyze',
      'moments',
      'tracks',
      'clips',
      'reel',
      'export',
      'dataset',
      'models',
      'jobs',
      'config',
      'doctor',
      'sports',
    ]) {
      expect(top).toContain(expected);
    }
  });

  it('accepts the PRD\'s documented invocations', () => {
    expect(find(program, 'probe')).toBeDefined();
    expect(namesAndAliases(find(program, 'analyze') as Command)).toContain('analyse');
    expect(find(find(program, 'dataset') as Command, 'export')).toBeDefined();
    expect(find(find(program, 'models') as Command, 'list')).toBeDefined();
    expect(find(find(program, 'project') as Command, 'create')).toBeDefined();
  });
});

describe('aliases', () => {
  const program = buildProgram();

  const expectAliases = (parent: string, sub: string, aliases: string[]): void => {
    const group = find(program, parent);
    expect(group, `${parent} should exist`).toBeDefined();
    const command = find(group as Command, sub);
    expect(command, `${parent} ${sub} should exist`).toBeDefined();
    const actual = namesAndAliases(command as Command);
    for (const alias of aliases) {
      expect(actual, `${parent} ${sub} should alias ${alias}`).toContain(alias);
    }
  };

  it('gives every list command an `ls` alias', () => {
    for (const group of ['project', 'athlete', 'moments', 'clips', 'reel', 'jobs', 'models']) {
      expectAliases(group, 'list', ['ls']);
    }
  });

  it('gives every update command `set` and `edit` aliases', () => {
    for (const group of ['project', 'athlete', 'moments', 'clips', 'reel', 'models', 'tracks']) {
      expectAliases(group, 'update', ['set', 'edit']);
    }
  });

  it('gives every remove command `rm`, `delete` and `del` aliases', () => {
    for (const group of ['project', 'athlete', 'moments', 'clips', 'reel', 'jobs', 'tracks']) {
      expectAliases(group, 'remove', ['rm', 'delete', 'del']);
    }
    // Models additionally answers to `uninstall`.
    expectAliases('models', 'remove', ['rm', 'delete', 'del', 'uninstall']);
  });

  it('aliases the plural and singular forms of each group', () => {
    expect(namesAndAliases(find(program, 'project') as Command)).toContain('projects');
    expect(namesAndAliases(find(program, 'athlete') as Command)).toEqual(
      expect.arrayContaining(['athletes', 'player', 'players']),
    );
    expect(namesAndAliases(find(program, 'clips') as Command)).toContain('clip');
    expect(namesAndAliases(find(program, 'reel') as Command)).toContain('reels');
    expect(namesAndAliases(find(program, 'moments') as Command)).toContain('highlights');
  });

  it('offers trim as an alias where trimming is the point', () => {
    expectAliases('moments', 'update', ['trim']);
    expectAliases('clips', 'update', ['trim']);
  });

  it('does not register the same alias twice on one parent', () => {
    for (const group of program.commands) {
      const seen = new Set<string>();
      for (const child of group.commands) {
        for (const token of namesAndAliases(child)) {
          expect(seen.has(token), `${group.name()} ${token} is registered twice`).toBe(false);
          seen.add(token);
        }
      }
    }
  });
});

describe('global options', () => {
  const program = buildProgram();
  const flags = program.options.map((option) => option.long);

  it('supports --json for scripting and --project for targeting', () => {
    expect(flags).toContain('--json');
    expect(flags).toContain('--project');
    expect(flags).toContain('--quiet');
  });
});
