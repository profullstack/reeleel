import chalk from 'chalk';
import type { Command } from 'commander';

import {
  JOB_STATUSES,
  PLANNED_SPORTS,
  cancelJob,
  configFilePath,
  flattenConfig,
  getJob,
  getJobLogs,
  getConfigValue,
  listJobs,
  listSports,
  loadConfig,
  pruneJobs,
  removeJob,
  retryJob,
  runChecks,
  saveConfig,
  setConfigValue,
  unsetConfigValue,
  worstStatus,
} from '@reeleel/core';
import type { JobStatus } from '@reeleel/core';

import { projectRoot } from '../context.js';
import { emit, fail, heading, info, say, success, table, warn } from '../output.js';

export const registerSystemCommands = (program: Command): void => {
  program
    .command('doctor')
    .aliases(['check'])
    .description('check that this machine can run ReelEel')
    .action(async () => {
      try {
        const checks = await runChecks();
        const overall = worstStatus(checks);

        emit({ ok: overall !== 'fail', status: overall, checks }, () => {
          for (const check of checks) {
            const mark =
              check.status === 'ok'
                ? chalk.green('✓')
                : check.status === 'warn'
                  ? chalk.yellow('!')
                  : chalk.red('✗');
            say(`${mark} ${check.name.padEnd(18)} ${check.detail}`);
            if (check.hint !== undefined) say(`  ${chalk.dim(check.hint)}`);
          }
          say();
          if (overall === 'fail') say(chalk.red('Some required components are missing.'));
          else if (overall === 'warn') say(chalk.yellow('Usable, with limitations noted above.'));
          else say(chalk.green('Everything checks out.'));
        });

        if (overall === 'fail') process.exitCode = 1;
      } catch (error) {
        fail(error);
      }
    });

  const sports = program
    .command('sports')
    .aliases(['sport'])
    .description('available sport plugins');

  sports
    .command('list', { isDefault: true })
    .aliases(['ls'])
    .description('list installed sport plugins')
    .action(() => {
      try {
        const installed = listSports();
        emit({ ok: true, sports: installed, planned: PLANNED_SPORTS }, () => {
          table(installed, [
            { header: 'ID', value: (s) => s.id },
            { header: 'NAME', value: (s) => s.name },
            { header: 'VERSION', value: (s) => s.version },
            {
              header: 'CLASSES',
              value: (s) =>
                s.classes
                  .filter((c) => !c.experimental)
                  .map((c) => c.name)
                  .join(', '),
            },
          ]);
          say();
          say(chalk.dim(`  Planned: ${PLANNED_SPORTS.join(', ')}`));
        });
      } catch (error) {
        fail(error);
      }
    });

  sports
    .command('show <id>')
    .aliases(['info'])
    .description('show a sport plugin in detail')
    .action((id: string) => {
      try {
        const plugin = listSports().find((candidate) => candidate.id === id);
        if (plugin === undefined) {
          warn(`No installed sport plugin with id "${id}".`);
          process.exitCode = 1;
          return;
        }
        emit({ ok: true, sport: plugin }, () => {
          heading(`${plugin.name} (${plugin.id}) v${plugin.version}`);
          say('  classes');
          for (const cls of plugin.classes) {
            say(
              `    ${cls.name.padEnd(14)} ${cls.experimental ? chalk.dim('experimental') : ''} ${chalk.dim(cls.description)}`,
            );
          }
          say('  tracker');
          say(`    ${plugin.tracker.algorithm}, min confidence ${plugin.tracker.minConfidence}`);
          say('  moment signals');
          for (const rule of plugin.moments.rules) {
            say(`    ${rule.id.padEnd(26)} weight ${rule.weight}  ${chalk.dim(rule.description)}`);
          }
        });
      } catch (error) {
        fail(error);
      }
    });

  const jobs = program.command('jobs').aliases(['job']).description('long-running work');

  jobs
    .command('list', { isDefault: true })
    .aliases(['ls'])
    .description('list jobs')
    .option('--status <status>', `filter: ${JOB_STATUSES.join(', ')}`)
    .option('--limit <n>', 'how many to show', Number, 20)
    .action(async function (this: Command, options: { status?: string; limit: number }) {
      try {
        const root = await projectRoot(this);
        const list = await listJobs(root, {
          ...(options.status === undefined ? {} : { status: options.status as JobStatus }),
          limit: options.limit,
        });

        emit({ ok: true, jobs: list }, () => {
          if (list.length === 0) {
            info('No jobs recorded.');
            return;
          }
          table(list, [
            { header: 'ID', value: (j) => j.id },
            { header: 'KIND', value: (j) => j.kind },
            {
              header: 'STATUS',
              value: (j) =>
                j.status === 'completed'
                  ? chalk.green(j.status)
                  : j.status === 'failed'
                    ? chalk.red(j.status)
                    : j.status === 'running'
                      ? chalk.cyan(j.status)
                      : chalk.dim(j.status),
            },
            { header: 'STAGE', value: (j) => j.stage ?? '—' },
            {
              header: 'PROGRESS',
              value: (j) => `${Math.round(j.progress * 100)}%`,
              align: 'right',
            },
            { header: 'STARTED', value: (j) => j.startedAt ?? '—' },
          ]);
        });
      } catch (error) {
        fail(error);
      }
    });

  jobs
    .command('show <id>')
    .aliases(['info', 'logs'])
    .description('show a job and its log')
    .action(async function (this: Command, id: string) {
      try {
        const root = await projectRoot(this);
        const job = await getJob(root, id);
        const logs = await getJobLogs(root, id);

        emit({ ok: true, job, logs }, () => {
          heading(`${job.kind} ${job.id}`);
          say(`  status    ${job.status}`);
          say(`  stage     ${job.stage ?? '—'}`);
          say(`  progress  ${Math.round(job.progress * 100)}%`);
          if (job.error !== null) say(`  error     ${chalk.red(job.error)}`);
          if (logs.length > 0) {
            say();
            for (const entry of logs) say(`  ${chalk.dim(entry.at)}  ${entry.message}`);
          }
        });
      } catch (error) {
        fail(error);
      }
    });

  jobs
    .command('cancel <id>')
    .aliases(['stop'])
    .description('cancel a queued or running job')
    .action(async function (this: Command, id: string) {
      try {
        const root = await projectRoot(this);
        const job = await cancelJob(root, id);
        emit({ ok: true, job }, () => success(`Canceled ${job.id}`));
      } catch (error) {
        fail(error);
      }
    });

  jobs
    .command('retry <id>')
    .description('re-queue a failed or canceled job with its original settings')
    .action(async function (this: Command, id: string) {
      try {
        const root = await projectRoot(this);
        const job = await retryJob(root, id);
        emit({ ok: true, job }, () => success(`Queued ${job.id} (${job.kind})`));
      } catch (error) {
        fail(error);
      }
    });

  jobs
    .command('remove <id>')
    .aliases(['rm', 'delete', 'del'])
    .description('delete a job record')
    .action(async function (this: Command, id: string) {
      try {
        const root = await projectRoot(this);
        const job = await removeJob(root, id);
        emit({ ok: true, job }, () => success(`Deleted job ${job.id}`));
      } catch (error) {
        fail(error);
      }
    });

  jobs
    .command('prune')
    .aliases(['clean'])
    .description('delete finished job records')
    .option('--status <list>', 'which statuses to prune', 'completed,failed,canceled')
    .action(async function (this: Command, options: { status: string }) {
      try {
        const root = await projectRoot(this);
        const statuses = options.status
          .split(',')
          .map((part) => part.trim())
          .filter((part): part is JobStatus => (JOB_STATUSES as readonly string[]).includes(part));
        const removed = await pruneJobs(root, statuses);
        emit({ ok: true, removed }, () => success(`Pruned ${removed} job record(s).`));
      } catch (error) {
        fail(error);
      }
    });

  const config = program
    .command('config')
    .aliases(['cfg'])
    .description('user settings');

  config
    .command('list', { isDefault: true })
    .aliases(['ls', 'get-all'])
    .description('show every setting')
    .action(() => {
      try {
        const current = loadConfig();
        const flat = flattenConfig(current);
        emit({ ok: true, config: current, path: configFilePath() }, () => {
          for (const [key, value] of Object.entries(flat)) {
            say(`${key.padEnd(34)} ${chalk.cyan(String(value))}`);
          }
          say();
          say(chalk.dim(`  ${configFilePath()}`));
        });
      } catch (error) {
        fail(error);
      }
    });

  config
    .command('get <key>')
    .description('read one setting')
    .action((key: string) => {
      try {
        const value = getConfigValue(loadConfig(), key);
        emit({ ok: true, key, value }, () => say(String(value)));
      } catch (error) {
        fail(error);
      }
    });

  config
    .command('set <key> <value>')
    .description('change one setting')
    .action((key: string, value: string) => {
      try {
        const next = setConfigValue(loadConfig(), key, value);
        saveConfig(next);
        emit({ ok: true, key, value: getConfigValue(next, key) }, () =>
          success(`${key} = ${String(getConfigValue(next, key))}`),
        );
      } catch (error) {
        fail(error);
      }
    });

  config
    .command('unset <key>')
    .aliases(['reset', 'remove', 'rm'])
    .description('reset one setting to its default')
    .action((key: string) => {
      try {
        const next = unsetConfigValue(loadConfig(), key);
        saveConfig(next);
        emit({ ok: true, key, value: getConfigValue(next, key) }, () =>
          success(`${key} reset to ${String(getConfigValue(next, key))}`),
        );
      } catch (error) {
        fail(error);
      }
    });

  config
    .command('path')
    .description('print the config file location')
    .action(() => {
      emit({ ok: true, path: configFilePath() }, () => say(configFilePath()));
    });
};
