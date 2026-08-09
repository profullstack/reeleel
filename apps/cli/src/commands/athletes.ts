import chalk from 'chalk';
import type { Command } from 'commander';

import {
  addAthlete,
  describeAthlete,
  getAthlete,
  listAthletes,
  removeAthlete,
  updateAthlete,
} from '@reeleel/core';

import { projectRoot } from '../context.js';
import { emit, fail, info, say, success, table } from '../output.js';

export const registerAthleteCommands = (program: Command): void => {
  const athlete = program
    .command('athlete')
    .aliases(['athletes', 'player', 'players'])
    .description('the athletes in a project — who ReelEel should follow');

  athlete
    .command('add')
    .aliases(['new', 'create'])
    .description('add an athlete')
    .option('--name <name>', 'display name')
    .option('--number <jersey>', 'jersey number')
    .option('--team <team>', 'team name')
    .option('--color <color>', 'jersey color')
    .option('--focal', 'make this the athlete ReelEel follows', false)
    .action(
      async function (
        this: Command,
        options: { name?: string; number?: string; team?: string; color?: string; focal: boolean },
      ) {
        try {
          const root = await projectRoot(this);
          const created = await addAthlete(root, {
            ...(options.name === undefined ? {} : { name: options.name }),
            ...(options.number === undefined ? {} : { jerseyNumber: options.number }),
            ...(options.team === undefined ? {} : { team: options.team }),
            ...(options.color === undefined ? {} : { jerseyColor: options.color }),
            ...(options.focal ? { focal: true } : {}),
          });

          emit({ ok: true, athlete: created }, () => {
            success(`Added ${chalk.bold(describeAthlete(created))}`);
            if (created.isFocal) info('This is the focal athlete — analysis will follow them.');
            // Identity is bound to a track during analysis, not here.
            say(
              chalk.dim(
                '  ReelEel identifies athletes by appearance and position, never by face.',
              ),
            );
          });
        } catch (error) {
          fail(error);
        }
      },
    );

  athlete
    .command('list')
    .aliases(['ls'])
    .description('list athletes in the project')
    .action(async function (this: Command) {
      try {
        const root = await projectRoot(this);
        const athletes = await listAthletes(root);

        emit({ ok: true, athletes }, () => {
          if (athletes.length === 0) {
            info('No athletes yet. Add one with `reeleel athlete add --name <who> --focal`.');
            return;
          }
          table(athletes, [
            { header: '', value: (a) => (a.isFocal ? chalk.green('●') : ' ') },
            { header: 'ID', value: (a) => a.id },
            { header: 'NAME', value: (a) => a.name ?? chalk.dim('(unnamed)') },
            { header: 'NUMBER', value: (a) => a.jerseyNumber ?? '—' },
            { header: 'TEAM', value: (a) => a.team ?? '—' },
            { header: 'TRACK', value: (a) => a.focalTrackId ?? chalk.dim('unbound') },
          ]);
        });
      } catch (error) {
        fail(error);
      }
    });

  athlete
    .command('show <ref>')
    .aliases(['info'])
    .description('show one athlete')
    .action(async function (this: Command, ref: string) {
      try {
        const root = await projectRoot(this);
        const found = await getAthlete(root, ref);
        emit({ ok: true, athlete: found }, () => {
          say(`${describeAthlete(found)}  ${chalk.dim(found.id)}`);
          say(`  focal      ${found.isFocal ? 'yes' : 'no'}`);
          say(`  track      ${found.focalTrackId ?? '(not bound yet)'}`);
          say(`  color      ${found.jerseyColor ?? '—'}`);
        });
      } catch (error) {
        fail(error);
      }
    });

  athlete
    .command('update <ref>')
    .aliases(['set', 'edit'])
    .description('change athlete details or rebind their track')
    .option('--name <name>', 'display name')
    .option('--number <jersey>', 'jersey number')
    .option('--team <team>', 'team name')
    .option('--color <color>', 'jersey color')
    .option('--focal', 'make this the focal athlete', false)
    .option('--track <trackId>', 'bind to a track ("" to unbind)')
    .action(
      async function (
        this: Command,
        ref: string,
        options: {
          name?: string;
          number?: string;
          team?: string;
          color?: string;
          focal: boolean;
          track?: string;
        },
      ) {
        try {
          const root = await projectRoot(this);
          const updated = await updateAthlete(root, ref, {
            ...(options.name === undefined ? {} : { name: options.name }),
            ...(options.number === undefined ? {} : { jerseyNumber: options.number }),
            ...(options.team === undefined ? {} : { team: options.team }),
            ...(options.color === undefined ? {} : { jerseyColor: options.color }),
            ...(options.focal ? { focal: true } : {}),
            ...(options.track === undefined
              ? {}
              : { focalTrackId: options.track.length === 0 ? null : options.track }),
          });
          emit({ ok: true, athlete: updated }, () =>
            success(`Updated ${describeAthlete(updated)}`),
          );
        } catch (error) {
          fail(error);
        }
      },
    );

  athlete
    .command('focus <ref>')
    .aliases(['focal'])
    .description('make an athlete the one ReelEel follows')
    .action(async function (this: Command, ref: string) {
      try {
        const root = await projectRoot(this);
        const updated = await updateAthlete(root, ref, { focal: true });
        emit({ ok: true, athlete: updated }, () =>
          success(`Now following ${describeAthlete(updated)}`),
        );
      } catch (error) {
        fail(error);
      }
    });

  athlete
    .command('remove <ref>')
    .aliases(['rm', 'delete', 'del'])
    .description('remove an athlete from the project')
    .action(async function (this: Command, ref: string) {
      try {
        const root = await projectRoot(this);
        const removed = await removeAthlete(root, ref);
        emit({ ok: true, athlete: removed }, () =>
          success(`Removed ${describeAthlete(removed)}`),
        );
      } catch (error) {
        fail(error);
      }
    });
};
