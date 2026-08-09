import path from 'node:path';

import chalk from 'chalk';
import type { Command } from 'commander';

import {
  createProject,
  importProject,
  listProjects,
  readManifest,
  removeProject,
  resolveProjectRoot,
  summarizeProject,
  updateProject,
} from '@reeleel/core';

import { collect, projectRoot } from '../context.js';
import { emit, fail, heading, info, say, success, table, warn } from '../output.js';

export const registerProjectCommands = (program: Command): void => {
  const project = program
    .command('project')
    .aliases(['projects', 'p'])
    .description('create, inspect, update and remove ReelEel projects');

  project
    .command('create <name>')
    .aliases(['new', 'init'])
    .description('create a new project directory')
    .option('--sport <sport>', 'sport plugin to use', 'soccer')
    .option('--path <dir>', 'where to create it (default: <projects.dir>/<slug>)')
    .option('--description <text>', 'free-form description')
    .option('--opponent <team>', 'opposing team')
    .option('--date <yyyy-mm-dd>', 'date the game was played')
    .option('--tag <tag>', 'repeatable tag', collect, [])
    .action(
      async (
        name: string,
        options: {
          sport: string;
          path?: string;
          description?: string;
          opponent?: string;
          date?: string;
          tag: string[];
        },
      ) => {
        try {
          const created = await createProject({
            name,
            sport: options.sport,
            ...(options.path === undefined ? {} : { path: options.path }),
            ...(options.description === undefined ? {} : { description: options.description }),
            ...(options.opponent === undefined ? {} : { opponent: options.opponent }),
            ...(options.date === undefined ? {} : { gameDate: options.date }),
            tags: options.tag,
          });

          emit({ ok: true, project: created.manifest, root: created.root }, () => {
            success(`Created ${chalk.bold(created.manifest.name)} (${created.manifest.sport})`);
            info(created.root);
            say();
            say('Next:');
            say(`  reeleel import <game.mp4> --project ${created.root}`);
          });
        } catch (error) {
          fail(error);
        }
      },
    );

  project
    .command('list')
    .aliases(['ls'])
    .description('list every project this machine knows about')
    .option('--sport <sport>', 'filter by sport')
    .action(async (options: { sport?: string }) => {
      try {
        const projects = (await listProjects()).filter(
          (entry) => options.sport === undefined || entry.sport === options.sport,
        );

        emit({ ok: true, projects }, () => {
          if (projects.length === 0) {
            info('No projects yet. Create one with `reeleel project create <name>`.');
            return;
          }
          table(projects, [
            { header: 'NAME', value: (p) => (p.exists ? p.name : chalk.dim(p.name)) },
            { header: 'SPORT', value: (p) => p.sport },
            { header: 'VIDEOS', value: (p) => String(p.videoCount), align: 'right' },
            { header: 'MOMENTS', value: (p) => String(p.momentCount), align: 'right' },
            {
              header: 'PATH',
              value: (p) => (p.exists ? p.root : chalk.red(`${p.root} (missing)`)),
            },
          ]);
        });
      } catch (error) {
        fail(error);
      }
    });

  project
    .command('show [ref]')
    .aliases(['info', 'view'])
    .description('show one project in detail')
    .action(async function (this: Command, ref?: string) {
      try {
        const root = await projectRoot(this, ref);
        const summary = await summarizeProject(root);

        emit({ ok: true, project: summary }, () => {
          heading(summary.name);
          say(`  id         ${summary.id}`);
          say(`  sport      ${summary.sport}`);
          say(`  path       ${summary.root}`);
          if (summary.opponent !== undefined) say(`  opponent   ${summary.opponent}`);
          if (summary.gameDate !== undefined) say(`  game date  ${summary.gameDate}`);
          if (summary.description !== undefined) say(`  about      ${summary.description}`);
          if (summary.tags !== undefined && summary.tags.length > 0) {
            say(`  tags       ${summary.tags.join(', ')}`);
          }
          say(`  videos     ${summary.videoCount}`);
          say(`  athletes   ${summary.athleteCount}`);
          say(`  moments    ${summary.momentCount}`);
          say(`  created    ${summary.createdAt}`);
        });
      } catch (error) {
        fail(error);
      }
    });

  project
    .command('update [ref]')
    .aliases(['set', 'edit'])
    .description('change a project\'s metadata')
    .option('--name <name>', 'rename the project')
    .option('--sport <sport>', 'change the sport plugin')
    .option('--description <text>', 'set the description ("" clears it)')
    .option('--opponent <team>', 'set the opponent ("" clears it)')
    .option('--date <yyyy-mm-dd>', 'set the game date ("" clears it)')
    .option('--tag <tag>', 'replace tags (repeatable)', collect)
    .action(
      async function (
        this: Command,
        ref: string | undefined,
        options: {
          name?: string;
          sport?: string;
          description?: string;
          opponent?: string;
          date?: string;
          tag?: string[];
        },
      ) {
        try {
          const root = await projectRoot(this, ref);
          // An empty string is how the CLI expresses "clear this field".
          const clearable = (value: string | undefined): string | null | undefined =>
            value === undefined ? undefined : value.length === 0 ? null : value;

          const updated = await updateProject(root, {
            ...(options.name === undefined ? {} : { name: options.name }),
            ...(options.sport === undefined ? {} : { sport: options.sport }),
            description: clearable(options.description),
            opponent: clearable(options.opponent),
            gameDate: clearable(options.date),
            ...(options.tag === undefined ? {} : { tags: options.tag }),
          });

          emit({ ok: true, project: updated }, () => {
            success(`Updated ${chalk.bold(updated.name)}`);
          });
        } catch (error) {
          fail(error);
        }
      },
    );

  project
    .command('remove [ref]')
    .aliases(['rm', 'delete', 'del'])
    .description('remove a project from the registry, and optionally from disk')
    .option('--delete-files', 'also delete the project directory (destructive)', false)
    .option('--derived-only', 'delete only regenerable output (proxies, clips, exports)', false)
    .option('--forget', 'only drop the registry entry, leave files alone', false)
    .option('-y, --yes', 'skip the confirmation prompt', false)
    .action(
      async function (
        this: Command,
        ref: string | undefined,
        options: { deleteFiles: boolean; derivedOnly: boolean; forget: boolean; yes: boolean },
      ) {
        try {
          const root = await projectRoot(this, ref);
          const manifest = options.derivedOnly ? readManifest(root) : null;

          // Deleting footage is not undoable, so require an explicit yes.
          if (options.deleteFiles && !options.yes) {
            warn(`This will permanently delete ${root} and everything in it.`);
            info('Re-run with --yes to confirm.');
            process.exitCode = 1;
            return;
          }

          const result = await removeProject(root, {
            deleteFiles: options.deleteFiles,
            derivedOnly: options.derivedOnly,
          });

          emit({ ok: true, ...result }, () => {
            if (options.derivedOnly) {
              success(
                `Cleared derived data for ${chalk.bold(manifest?.name ?? path.basename(root))}`,
              );
              for (const deleted of result.deletedPaths) info(deleted);
              return;
            }
            success(
              options.deleteFiles
                ? `Deleted ${result.root}`
                : `Removed ${result.root} from the registry (files kept)`,
            );
          });
        } catch (error) {
          fail(error);
        }
      },
    );

  project
    .command('clean [ref]')
    .description('delete regenerable output but keep sources and decisions')
    .action(async function (this: Command, ref?: string) {
      try {
        const root = await projectRoot(this, ref);
        const result = await removeProject(root, { derivedOnly: true });
        emit({ ok: true, ...result }, () => {
          success(`Cleared ${result.deletedPaths.length} derived director(ies).`);
          info('Analysis will need to run again; your accepted moments and clips are untouched.');
        });
      } catch (error) {
        fail(error);
      }
    });

  project
    .command('import <dir>')
    .aliases(['register', 'add'])
    .description('register an existing project directory with this machine')
    .action(async (dir: string) => {
      try {
        const manifest = await importProject(dir);
        emit({ ok: true, project: manifest, root: path.resolve(dir) }, () => {
          success(`Registered ${chalk.bold(manifest.name)} from ${path.resolve(dir)}`);
        });
      } catch (error) {
        fail(error);
      }
    });

  // `reeleel project` with no subcommand is almost always "show me my projects".
  project.action(async () => {
    await project.parseAsync(['list'], { from: 'user' });
  });
};

/** Resolve without touching the registry — used by commands that only read. */
export const resolveReadOnly = async (ref?: string): Promise<string> => resolveProjectRoot(ref);
