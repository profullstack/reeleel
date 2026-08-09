import path from 'node:path';

import chalk from 'chalk';
import type { Command } from 'commander';

import {
  ASPECT_RATIOS,
  CAMERA_MODES,
  addClip,
  addClipsToReel,
  clipsFromMoments,
  createReel,
  getClip,
  isAspectRatio,
  isCameraMode,
  listClips,
  listExports,
  listReels,
  parseTimecode,
  removeClip,
  removeClipsFromReel,
  removeExport,
  removeReel,
  renderClip,
  renderReel,
  reorderClips,
  updateClip,
  updateReel,
} from '@reeleel/core';
import type { AspectRatio, CameraMode } from '@reeleel/core';

import { collect, projectRoot } from '../context.js';
import { emit, fail, formatDuration, info, say, success, table, warn } from '../output.js';

export const registerEditCommands = (program: Command): void => {
  const clips = program
    .command('clips')
    .aliases(['clip'])
    .description('the clips that make up a reel');

  clips
    .command('list', { isDefault: true })
    .aliases(['ls'])
    .description('list clips in timeline order')
    .action(async function (this: Command) {
      try {
        const root = await projectRoot(this);
        const list = await listClips(root);

        emit({ ok: true, clips: list }, () => {
          if (list.length === 0) {
            info('No clips yet. Try `reeleel clips from-moments` after reviewing suggestions.');
            return;
          }
          table(
            list.map((clip, index) => ({ ...clip, index: index + 1 })),
            [
              { header: '#', value: (c) => String(c.index), align: 'right' },
              { header: 'ID', value: (c) => c.id },
              { header: 'START', value: (c) => formatDuration(c.start) },
              { header: 'LEN', value: (c) => `${(c.end - c.start).toFixed(1)}s`, align: 'right' },
              { header: 'CAMERA', value: (c) => c.cameraMode },
              { header: 'TITLE', value: (c) => c.title ?? chalk.dim('—') },
              {
                header: 'RENDERED',
                value: (c) => (c.renderedPath === null ? chalk.dim('no') : 'yes'),
              },
            ],
          );
        });
      } catch (error) {
        fail(error);
      }
    });

  clips
    .command('from-moments')
    .aliases(['generate'])
    .description('turn every kept moment into a clip')
    .option('--include-undecided', 'also include moments you have not reviewed', false)
    .option('--camera <mode>', `camera mode: ${CAMERA_MODES.join(', ')}`, 'follow-player')
    .action(
      async function (this: Command, options: { includeUndecided: boolean; camera: string }) {
        try {
          if (!isCameraMode(options.camera)) {
            warn(`Unknown camera mode "${options.camera}". Valid: ${CAMERA_MODES.join(', ')}`);
            process.exitCode = 1;
            return;
          }
          const root = await projectRoot(this);
          const created = await clipsFromMoments(root, {
            includeUndecided: options.includeUndecided,
            cameraMode: options.camera,
          });
          emit({ ok: true, clips: created }, () => {
            if (created.length === 0) {
              info('Nothing to do — every kept moment already has a clip.');
              return;
            }
            success(`Created ${created.length} clip(s).`);
          });
        } catch (error) {
          fail(error);
        }
      },
    );

  clips
    .command('add')
    .aliases(['new'])
    .description('add a clip by hand')
    .requiredOption('--start <time>', 'start (seconds or mm:ss)')
    .requiredOption('--end <time>', 'end (seconds or mm:ss)')
    .option('--video <id>', 'source video')
    .option('--camera <mode>', `camera mode: ${CAMERA_MODES.join(', ')}`, 'follow-player')
    .option('--title <text>', 'clip title')
    .action(
      async function (
        this: Command,
        options: { start: string; end: string; video?: string; camera: string; title?: string },
      ) {
        try {
          if (!isCameraMode(options.camera)) {
            warn(`Unknown camera mode "${options.camera}".`);
            process.exitCode = 1;
            return;
          }
          const root = await projectRoot(this);
          const created = await addClip(root, {
            start: parseTimecode(options.start),
            end: parseTimecode(options.end),
            cameraMode: options.camera as CameraMode,
            ...(options.video === undefined ? {} : { videoId: options.video }),
            ...(options.title === undefined ? {} : { title: options.title }),
          });
          emit({ ok: true, clip: created }, () => success(`Added clip ${created.id}`));
        } catch (error) {
          fail(error);
        }
      },
    );

  clips
    .command('update <ref>')
    .aliases(['set', 'edit', 'trim'])
    .description('trim a clip, retitle it or change its camera mode')
    .option('--start <time>', 'new start')
    .option('--end <time>', 'new end')
    .option('--camera <mode>', `camera mode: ${CAMERA_MODES.join(', ')}`)
    .option('--title <text>', 'set a title ("" clears it)')
    .option('--order <n>', 'position in the timeline', Number)
    .action(
      async function (
        this: Command,
        ref: string,
        options: {
          start?: string;
          end?: string;
          camera?: string;
          title?: string;
          order?: number;
        },
      ) {
        try {
          if (options.camera !== undefined && !isCameraMode(options.camera)) {
            warn(`Unknown camera mode "${options.camera}".`);
            process.exitCode = 1;
            return;
          }
          const root = await projectRoot(this);
          const updated = await updateClip(root, ref, {
            ...(options.start === undefined ? {} : { start: parseTimecode(options.start) }),
            ...(options.end === undefined ? {} : { end: parseTimecode(options.end) }),
            ...(options.camera === undefined ? {} : { cameraMode: options.camera as CameraMode }),
            ...(options.title === undefined
              ? {}
              : { title: options.title.length === 0 ? null : options.title }),
            ...(options.order === undefined ? {} : { order: options.order }),
          });
          emit({ ok: true, clip: updated }, () => {
            success(`${formatDuration(updated.start)} → ${formatDuration(updated.end)}`);
            if (updated.renderedPath === null) {
              info('The previous render was invalidated; re-render when you are happy with it.');
            }
          });
        } catch (error) {
          fail(error);
        }
      },
    );

  clips
    .command('reorder <ids...>')
    .description('set the timeline order (unlisted clips keep their relative order)')
    .action(async function (this: Command, ids: string[]) {
      try {
        const root = await projectRoot(this);
        const ordered = await reorderClips(root, ids);
        emit({ ok: true, clips: ordered }, () => success('Timeline reordered.'));
      } catch (error) {
        fail(error);
      }
    });

  clips
    .command('remove <ref>')
    .aliases(['rm', 'delete', 'del'])
    .description('delete a clip')
    .action(async function (this: Command, ref: string) {
      try {
        const root = await projectRoot(this);
        const removed = await removeClip(root, ref);
        emit({ ok: true, clip: removed }, () => success(`Deleted clip ${removed.id}`));
      } catch (error) {
        fail(error);
      }
    });

  clips
    .command('render <ref>')
    .description('render one clip with the Virtual Cameraman crop')
    .option('--aspect <ratio>', `output aspect: ${ASPECT_RATIOS.join(', ')}`, '16:9')
    .option('--no-crop', 'keep the full frame instead of following the athlete')
    .action(async function (this: Command, ref: string, options: { aspect: string; crop: boolean }) {
      try {
        if (!isAspectRatio(options.aspect)) {
          warn(`Unknown aspect "${options.aspect}". Valid: ${ASPECT_RATIOS.join(', ')}`);
          process.exitCode = 1;
          return;
        }
        const root = await projectRoot(this);
        const clip = await getClip(root, ref);
        const output = await renderClip(root, clip.id, {
          aspect: options.aspect,
          noCrop: options.crop === false,
        });
        emit({ ok: true, output }, () => success(`Rendered ${output}`));
      } catch (error) {
        fail(error);
      }
    });

  const reel = program.command('reel').aliases(['reels']).description('assemble and render reels');

  reel
    .command('list', { isDefault: true })
    .aliases(['ls'])
    .description('list reels')
    .action(async function (this: Command) {
      try {
        const root = await projectRoot(this);
        const list = await listReels(root);
        emit({ ok: true, reels: list }, () => {
          if (list.length === 0) {
            info('No reels yet. Create one with `reeleel reel create <name>`.');
            return;
          }
          table(list, [
            { header: 'NAME', value: (r) => r.name },
            { header: 'ASPECT', value: (r) => r.aspect },
            { header: 'CLIPS', value: (r) => String(r.clipIds.length), align: 'right' },
            { header: 'AUDIO', value: (r) => (r.keepOriginalAudio ? 'original' : 'muted') },
          ]);
        });
      } catch (error) {
        fail(error);
      }
    });

  reel
    .command('create <name>')
    .aliases(['new'])
    .description('create a reel from the current clips')
    .option('--aspect <ratio>', `output aspect: ${ASPECT_RATIOS.join(', ')}`, '16:9')
    .option('--clip <id>', 'specific clips, in order (repeatable)', collect)
    .option('--title-card <text>', 'opening title card')
    .option('--music <file>', 'background audio file')
    .option('--no-original-audio', 'mute the original game audio')
    .action(
      async function (
        this: Command,
        name: string,
        options: {
          aspect: string;
          clip?: string[];
          titleCard?: string;
          music?: string;
          originalAudio: boolean;
        },
      ) {
        try {
          if (!isAspectRatio(options.aspect)) {
            warn(`Unknown aspect "${options.aspect}".`);
            process.exitCode = 1;
            return;
          }
          const root = await projectRoot(this);
          const created = await createReel(root, {
            name,
            aspect: options.aspect,
            ...(options.clip === undefined ? {} : { clipIds: options.clip }),
            ...(options.titleCard === undefined ? {} : { titleCard: options.titleCard }),
            ...(options.music === undefined ? {} : { music: options.music }),
            keepOriginalAudio: options.originalAudio !== false,
          });
          emit({ ok: true, reel: created }, () => {
            success(`Created reel ${chalk.bold(created.name)} with ${created.clipIds.length} clip(s).`);
            say(`Render it: reeleel export --reel ${created.name}`);
          });
        } catch (error) {
          fail(error);
        }
      },
    );

  reel
    .command('update <ref>')
    .aliases(['set', 'edit'])
    .description('rename a reel, change its aspect, or replace its clip list')
    .option('--name <name>', 'rename')
    .option('--aspect <ratio>', `output aspect: ${ASPECT_RATIOS.join(', ')}`)
    .option('--clip <id>', 'replace the clip list (repeatable, in order)', collect)
    .option('--title-card <text>', 'set the title card ("" clears it)')
    .option('--music <file>', 'set background audio ("" clears it)')
    .option('--original-audio <on|off>', 'keep or mute the original audio')
    .action(
      async function (
        this: Command,
        ref: string,
        options: {
          name?: string;
          aspect?: string;
          clip?: string[];
          titleCard?: string;
          music?: string;
          originalAudio?: string;
        },
      ) {
        try {
          if (options.aspect !== undefined && !isAspectRatio(options.aspect)) {
            warn(`Unknown aspect "${options.aspect}".`);
            process.exitCode = 1;
            return;
          }
          const root = await projectRoot(this);
          const updated = await updateReel(root, ref, {
            ...(options.name === undefined ? {} : { name: options.name }),
            ...(options.aspect === undefined ? {} : { aspect: options.aspect as AspectRatio }),
            ...(options.clip === undefined ? {} : { clipIds: options.clip }),
            ...(options.titleCard === undefined
              ? {}
              : { titleCard: options.titleCard.length === 0 ? null : options.titleCard }),
            ...(options.music === undefined
              ? {}
              : { music: options.music.length === 0 ? null : options.music }),
            ...(options.originalAudio === undefined
              ? {}
              : { keepOriginalAudio: ['on', 'true', 'yes'].includes(options.originalAudio) }),
          });
          emit({ ok: true, reel: updated }, () => success(`Updated reel ${updated.name}`));
        } catch (error) {
          fail(error);
        }
      },
    );

  reel
    .command('add-clips <ref> <ids...>')
    .description('append clips to a reel')
    .action(async function (this: Command, ref: string, ids: string[]) {
      try {
        const root = await projectRoot(this);
        const updated = await addClipsToReel(root, ref, ids);
        emit({ ok: true, reel: updated }, () =>
          success(`${updated.name} now has ${updated.clipIds.length} clip(s).`),
        );
      } catch (error) {
        fail(error);
      }
    });

  reel
    .command('remove-clips <ref> <ids...>')
    .description('drop clips from a reel (the clips themselves are kept)')
    .action(async function (this: Command, ref: string, ids: string[]) {
      try {
        const root = await projectRoot(this);
        const updated = await removeClipsFromReel(root, ref, ids);
        emit({ ok: true, reel: updated }, () =>
          success(`${updated.name} now has ${updated.clipIds.length} clip(s).`),
        );
      } catch (error) {
        fail(error);
      }
    });

  reel
    .command('remove <ref>')
    .aliases(['rm', 'delete', 'del'])
    .description('delete a reel (its clips are kept)')
    .action(async function (this: Command, ref: string) {
      try {
        const root = await projectRoot(this);
        const removed = await removeReel(root, ref);
        emit({ ok: true, reel: removed }, () => success(`Deleted reel ${removed.name}`));
      } catch (error) {
        fail(error);
      }
    });

  program
    .command('export [ref]')
    .aliases(['render'])
    .description('render a reel to a shareable MP4')
    .option('--reel <name>', 'which reel to render', 'highlights')
    .option('--aspect <ratio>', `output aspect: ${ASPECT_RATIOS.join(', ')}`)
    .option('--fps <n>', 'output frame rate', Number)
    .option('--quality <level>', 'low, medium or high', 'high')
    .option('--output <file>', 'write to a specific path')
    .option('--label <text>', 'burn a name/number label into the corner')
    .option('--watermark', 'add a small ReelEel watermark', false)
    .action(
      async function (
        this: Command,
        ref: string | undefined,
        options: {
          reel: string;
          aspect?: string;
          fps?: number;
          quality: string;
          output?: string;
          label?: string;
          watermark: boolean;
        },
      ) {
        try {
          if (options.aspect !== undefined && !isAspectRatio(options.aspect)) {
            warn(`Unknown aspect "${options.aspect}". Valid: ${ASPECT_RATIOS.join(', ')}`);
            process.exitCode = 1;
            return;
          }
          if (!['low', 'medium', 'high'].includes(options.quality)) {
            warn(`Unknown quality "${options.quality}". Valid: low, medium, high`);
            process.exitCode = 1;
            return;
          }

          const root = await projectRoot(this, ref);
          const result = await renderReel(root, options.reel, {
            ...(options.aspect === undefined ? {} : { aspect: options.aspect as AspectRatio }),
            ...(options.fps === undefined ? {} : { fps: options.fps }),
            quality: options.quality as 'low' | 'medium' | 'high',
            ...(options.output === undefined ? {} : { output: options.output }),
            ...(options.label === undefined ? {} : { label: options.label }),
            watermark: options.watermark,
            onProgress: (stage) => info(stage),
          });

          emit({ ok: true, ...result }, () => {
            success(`Exported ${chalk.bold(path.basename(result.outputPath))}`);
            say(`  ${result.outputPath}`);
            say(
              `  ${result.clipCount} clip(s), ${formatDuration(result.durationSeconds)} of footage`,
            );
          });
        } catch (error) {
          fail(error);
        }
      },
    );

  const exports = program
    .command('exports')
    .description('previously rendered reels');

  exports
    .command('list', { isDefault: true })
    .aliases(['ls'])
    .description('list exports')
    .action(async function (this: Command) {
      try {
        const root = await projectRoot(this);
        const list = await listExports(root);
        emit({ ok: true, exports: list }, () => {
          if (list.length === 0) {
            info('Nothing exported yet.');
            return;
          }
          table(list, [
            { header: 'ID', value: (e) => e.id },
            { header: 'ASPECT', value: (e) => e.aspect },
            { header: 'WHEN', value: (e) => e.createdAt },
            { header: 'PATH', value: (e) => e.path },
          ]);
        });
      } catch (error) {
        fail(error);
      }
    });

  exports
    .command('remove <id>')
    .aliases(['rm', 'delete', 'del'])
    .description('forget an export, and optionally delete the file')
    .option('--delete-file', 'also delete the rendered MP4', false)
    .action(async function (this: Command, id: string, options: { deleteFile: boolean }) {
      try {
        const root = await projectRoot(this);
        const removed = await removeExport(root, id, options.deleteFile);
        emit({ ok: true, export: removed }, () =>
          success(options.deleteFile ? `Deleted ${removed.path}` : `Forgot export ${removed.id}`),
        );
      } catch (error) {
        fail(error);
      }
    });
};
