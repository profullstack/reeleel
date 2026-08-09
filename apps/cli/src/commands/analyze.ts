import chalk from 'chalk';
import type { Command } from 'commander';

import {
  addMoment,
  analyzeProject,
  clearAnalysis,
  generateMoments,
  getMoment,
  listMoments,
  listTracks,
  mergeTracks,
  parseTimecode,
  removeMoment,
  removeTrack,
  splitTrack,
  updateMoment,
  updateTrack,
} from '@reeleel/core';
import type { Preset } from '@reeleel/core';

import { projectRoot } from '../context.js';
import {
  emit,
  fail,
  formatDecision,
  formatDuration,
  formatScore,
  info,
  say,
  success,
  table,
  warn,
} from '../output.js';

const PRESETS = ['fast', 'balanced', 'accurate', 'custom'];

export const registerAnalyzeCommands = (program: Command): void => {
  program
    .command('analyze [ref]')
    .aliases(['analyse'])
    .description('run detection, tracking and moment scoring on a project')
    .option('--preset <preset>', `one of: ${PRESETS.join(', ')}`)
    .option('--video <ref>', 'analyze a single video')
    .option('--skip-media', 'skip proxy and thumbnail generation', false)
    .option('--score-only', 're-score existing tracks without re-running detection', false)
    .action(
      async function (
        this: Command,
        ref: string | undefined,
        options: { preset?: string; video?: string; skipMedia: boolean; scoreOnly: boolean },
      ) {
        try {
          if (options.preset !== undefined && !PRESETS.includes(options.preset)) {
            warn(`Unknown preset "${options.preset}". Valid: ${PRESETS.join(', ')}`);
            process.exitCode = 1;
            return;
          }

          const root = await projectRoot(this, ref);
          const controller = new AbortController();
          const onSigint = (): void => {
            warn('Canceling…');
            controller.abort();
          };
          process.once('SIGINT', onSigint);

          try {
            const result = await analyzeProject(root, {
              ...(options.preset === undefined ? {} : { preset: options.preset as Preset }),
              ...(options.video === undefined ? {} : { videoId: options.video }),
              skipMedia: options.skipMedia,
              scoreOnly: options.scoreOnly,
              signal: controller.signal,
              onStage: (stage, detail) => {
                info(detail === undefined ? stage : `${stage} — ${detail}`);
              },
            });

            emit({ ok: true, ...result }, () => {
              success(
                `Analysis complete: ${result.tracksCreated} track(s), ${result.momentsGenerated} suggested moment(s).`,
              );
              for (const warning of result.warnings) warn(warning);
              if (result.momentsGenerated > 0) {
                say();
                say('Review them with `reeleel moments list`.');
              }
            });
          } finally {
            process.off('SIGINT', onSigint);
          }
        } catch (error) {
          fail(error);
        }
      },
    );

  program
    .command('rescore [ref]')
    .description('re-score existing tracks into moments (never re-runs detection)')
    .option('--window <seconds>', 'scoring granularity', Number)
    .option('--keep', 'keep existing suggestions instead of replacing them', false)
    .action(
      async function (
        this: Command,
        ref: string | undefined,
        options: { window?: number; keep: boolean },
      ) {
        try {
          const root = await projectRoot(this, ref);
          const result = await generateMoments(root, {
            ...(options.window === undefined ? {} : { windowSeconds: options.window }),
            replace: !options.keep,
          });
          emit({ ok: true, ...result }, () => {
            success(`${result.generated} suggested moment(s) from existing tracks.`);
            if (result.skippedVideos.length > 0) {
              warn(`${result.skippedVideos.length} video(s) have no tracks yet — run \`reeleel analyze\`.`);
            }
          });
        } catch (error) {
          fail(error);
        }
      },
    );

  const moments = program
    .command('moments')
    .aliases(['moment', 'highlights'])
    .description('review, trim and curate suggested moments');

  moments
    .command('list', { isDefault: true })
    .aliases(['ls'])
    .description('list suggested moments in chronological order')
    .option('--included', 'only moments you kept', false)
    .option('--rejected', 'only moments you rejected', false)
    .option('--favorites', 'only favorites', false)
    .option('--min-score <n>', 'minimum score', Number)
    .action(
      async function (
        this: Command,
        options: { included: boolean; rejected: boolean; favorites: boolean; minScore?: number },
      ) {
        try {
          const root = await projectRoot(this);
          const list = await listMoments(root, {
            ...(options.included ? { included: true } : {}),
            ...(options.rejected ? { included: false } : {}),
            ...(options.favorites ? { favorite: true } : {}),
            ...(options.minScore === undefined ? {} : { minScore: options.minScore }),
          });

          emit({ ok: true, moments: list }, () => {
            if (list.length === 0) {
              info('No suggested moments. Run `reeleel analyze` first.');
              return;
            }
            table(
              list.map((moment, index) => ({ ...moment, index: index + 1 })),
              [
                { header: '#', value: (m) => String(m.index), align: 'right' },
                { header: 'START', value: (m) => formatDuration(m.start) },
                { header: 'LEN', value: (m) => `${(m.end - m.start).toFixed(1)}s`, align: 'right' },
                { header: 'SCORE', value: (m) => formatScore(m.score), align: 'right' },
                { header: 'STATUS', value: (m) => formatDecision(m.included) },
                { header: '', value: (m) => (m.favorite ? chalk.yellow('★') : ' ') },
                {
                  header: 'WHY',
                  value: (m) => (m.manual ? chalk.cyan('you marked this') : m.reasons.join(', ')),
                },
              ],
            );
            say();
            say(chalk.dim('  keep: reeleel moments update <#> --include     drop: --exclude'));
          });
        } catch (error) {
          fail(error);
        }
      },
    );

  moments
    .command('show <ref>')
    .aliases(['info'])
    .description('show one moment')
    .action(async function (this: Command, ref: string) {
      try {
        const root = await projectRoot(this);
        const moment = await getMoment(root, ref);
        emit({ ok: true, moment }, () => {
          say(`${formatDuration(moment.start)} → ${formatDuration(moment.end)}  ${chalk.dim(moment.id)}`);
          say(`  score    ${formatScore(moment.score)}`);
          say(`  status   ${formatDecision(moment.included)}`);
          say(`  reasons  ${moment.reasons.join(', ')}`);
          if (moment.title !== null) say(`  title    ${moment.title}`);
        });
      } catch (error) {
        fail(error);
      }
    });

  moments
    .command('add')
    .aliases(['mark', 'new'])
    .description('mark a moment yourself, anywhere on the timeline')
    .requiredOption('--start <time>', 'start (seconds or mm:ss)')
    .requiredOption('--end <time>', 'end (seconds or mm:ss)')
    .option('--title <text>', 'label for the moment')
    .option('--video <id>', 'which video this belongs to')
    .action(
      async function (
        this: Command,
        options: { start: string; end: string; title?: string; video?: string },
      ) {
        try {
          const root = await projectRoot(this);
          const created = await addMoment(root, {
            start: parseTimecode(options.start),
            end: parseTimecode(options.end),
            ...(options.title === undefined ? {} : { title: options.title }),
            ...(options.video === undefined ? {} : { videoId: options.video }),
            manual: true,
            included: true,
          });
          emit({ ok: true, moment: created }, () =>
            success(
              `Marked ${formatDuration(created.start)} → ${formatDuration(created.end)} and kept it.`,
            ),
          );
        } catch (error) {
          fail(error);
        }
      },
    );

  moments
    .command('update <ref>')
    .aliases(['set', 'edit', 'trim'])
    .description('accept, reject, trim, retitle or favorite a moment')
    .option('--include', 'keep this moment', false)
    .option('--exclude', 'reject this moment', false)
    .option('--undecided', 'clear the decision', false)
    .option('--start <time>', 'new start (seconds or mm:ss)')
    .option('--end <time>', 'new end (seconds or mm:ss)')
    .option('--title <text>', 'set a title ("" clears it)')
    .option('--favorite', 'mark as favorite', false)
    .option('--unfavorite', 'clear favorite', false)
    .action(
      async function (
        this: Command,
        ref: string,
        options: {
          include: boolean;
          exclude: boolean;
          undecided: boolean;
          start?: string;
          end?: string;
          title?: string;
          favorite: boolean;
          unfavorite: boolean;
        },
      ) {
        try {
          if (options.include && options.exclude) {
            warn('--include and --exclude are mutually exclusive.');
            process.exitCode = 1;
            return;
          }

          const root = await projectRoot(this);
          const included = options.undecided
            ? null
            : options.include
              ? true
              : options.exclude
                ? false
                : undefined;

          const updated = await updateMoment(root, ref, {
            ...(included === undefined ? {} : { included }),
            ...(options.start === undefined ? {} : { start: parseTimecode(options.start) }),
            ...(options.end === undefined ? {} : { end: parseTimecode(options.end) }),
            ...(options.title === undefined
              ? {}
              : { title: options.title.length === 0 ? null : options.title }),
            ...(options.favorite ? { favorite: true } : {}),
            ...(options.unfavorite ? { favorite: false } : {}),
          });

          emit({ ok: true, moment: updated }, () =>
            success(
              `${formatDuration(updated.start)} → ${formatDuration(updated.end)}  ${formatDecision(updated.included)}`,
            ),
          );
        } catch (error) {
          fail(error);
        }
      },
    );

  moments
    .command('remove <ref>')
    .aliases(['rm', 'delete', 'del'])
    .description('delete a moment entirely')
    .action(async function (this: Command, ref: string) {
      try {
        const root = await projectRoot(this);
        const removed = await removeMoment(root, ref);
        emit({ ok: true, moment: removed }, () =>
          success(`Deleted moment at ${formatDuration(removed.start)}`),
        );
      } catch (error) {
        fail(error);
      }
    });

  const tracks = program
    .command('tracks')
    .aliases(['track'])
    .description('inspect and correct tracking output');

  tracks
    .command('list', { isDefault: true })
    .aliases(['ls'])
    .description('list tracks')
    .option('--video <id>', 'restrict to one video')
    .option('--class <name>', 'restrict to one class')
    .action(async function (this: Command, options: { video?: string; class?: string }) {
      try {
        const root = await projectRoot(this);
        const list = (await listTracks(root, options.video)).filter(
          (track) => options.class === undefined || track.className === options.class,
        );

        emit({ ok: true, tracks: list }, () => {
          if (list.length === 0) {
            info('No tracks. Run `reeleel analyze` to produce them.');
            return;
          }
          table(list, [
            { header: 'ID', value: (t) => t.id },
            { header: 'CLASS', value: (t) => t.className },
            { header: 'FRAMES', value: (t) => `${t.startFrame ?? '?'}–${t.endFrame ?? '?'}` },
            { header: 'POINTS', value: (t) => String(t.pointCount), align: 'right' },
            { header: 'CONF', value: (t) => t.confidence.toFixed(2), align: 'right' },
            {
              header: '',
              value: (t) => (t.uncertain ? chalk.yellow('uncertain') : ''),
            },
          ]);
        });
      } catch (error) {
        fail(error);
      }
    });

  tracks
    .command('update <id>')
    .aliases(['set', 'edit'])
    .description('correct a track\'s class, athlete or certainty')
    .option('--class <name>', 'reassign the object class')
    .option('--athlete <id>', 'bind to an athlete ("" to unbind)')
    .option('--uncertain', 'flag as uncertain', false)
    .option('--certain', 'clear the uncertain flag', false)
    .action(
      async function (
        this: Command,
        id: string,
        options: { class?: string; athlete?: string; uncertain: boolean; certain: boolean },
      ) {
        try {
          const root = await projectRoot(this);
          const updated = await updateTrack(root, id, {
            ...(options.class === undefined ? {} : { className: options.class }),
            ...(options.athlete === undefined
              ? {}
              : { athleteId: options.athlete.length === 0 ? null : options.athlete }),
            ...(options.uncertain ? { uncertain: true } : {}),
            ...(options.certain ? { uncertain: false } : {}),
          });
          emit({ ok: true, track: updated }, () => success(`Updated track ${updated.id}`));
        } catch (error) {
          fail(error);
        }
      },
    );

  tracks
    .command('merge <targetId> <sourceId>')
    .description('fuse two tracks that are really the same object')
    .action(async function (this: Command, targetId: string, sourceId: string) {
      try {
        const root = await projectRoot(this);
        const merged = await mergeTracks(root, targetId, sourceId);
        emit({ ok: true, track: merged }, () =>
          success(`Merged ${sourceId} into ${merged.id} (${merged.pointCount} points)`),
        );
      } catch (error) {
        fail(error);
      }
    });

  tracks
    .command('split <id> <frame>')
    .description('split a track where the tracker swapped identity')
    .action(async function (this: Command, id: string, frame: string) {
      try {
        const root = await projectRoot(this);
        const created = await splitTrack(root, id, Number(frame));
        emit({ ok: true, track: created }, () =>
          success(`Split at frame ${frame}; the tail is now ${created.id} (flagged uncertain).`),
        );
      } catch (error) {
        fail(error);
      }
    });

  tracks
    .command('remove <id>')
    .aliases(['rm', 'delete', 'del'])
    .description('delete a track')
    .action(async function (this: Command, id: string) {
      try {
        const root = await projectRoot(this);
        await removeTrack(root, id);
        emit({ ok: true, id }, () => success(`Deleted track ${id}`));
      } catch (error) {
        fail(error);
      }
    });

  tracks
    .command('clear')
    .aliases(['reset'])
    .description('discard all cached analysis (tracks, detections, auto moments)')
    .action(async function (this: Command) {
      try {
        const root = await projectRoot(this);
        const result = await clearAnalysis(root);
        emit({ ok: true, ...result }, () => {
          success(`Cleared ${result.tracks} track(s) and ${result.moments} suggested moment(s).`);
          info('Moments you marked yourself were kept.');
        });
      } catch (error) {
        fail(error);
      }
    });
};
