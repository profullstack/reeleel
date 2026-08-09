import path from 'node:path';

import chalk from 'chalk';
import type { Command } from 'commander';

import {
  addVideo,
  findMissingSources,
  generateProxy,
  generateThumbnails,
  getVideo,
  listVideos,
  probe,
  removeVideo,
  updateVideo,
} from '@reeleel/core';
import type { SourceVideo } from '@reeleel/core';

import { projectRoot } from '../context.js';
import { emit, fail, formatBytes, formatDuration, heading, info, say, success, table, warn } from '../output.js';

export const registerMediaCommands = (program: Command): void => {
  program
    .command('probe <file>')
    .description('inspect a media file with ffprobe without importing it')
    .action(async (file: string) => {
      try {
        const result = await probe(file);
        emit({ ok: true, probe: result }, () => {
          heading(path.basename(result.path));
          say(`  container  ${result.container}`);
          say(`  duration   ${formatDuration(result.durationSeconds)}`);
          say(`  size       ${formatBytes(result.sizeBytes)}`);
          if (result.video !== undefined) {
            say(
              `  video      ${result.video.codec} ${result.video.width}x${result.video.height} @ ${result.video.fps.toFixed(2)}fps`,
            );
            if (result.video.rotation !== 0) say(`  rotation   ${result.video.rotation}°`);
          }
          if (result.audio !== undefined) {
            say(
              `  audio      ${result.audio.codec} ${result.audio.channels}ch @ ${result.audio.sampleRate}Hz`,
            );
          }
        });
      } catch (error) {
        fail(error);
      }
    });

  const media = program
    .command('import [files...]')
    .aliases(['video', 'videos'])
    .description('import game footage into a project (also: import list/update/remove)')
    .option('--copy', 'copy the file into the project instead of referencing it', false)
    .action(async function (this: Command, files: string[], options: { copy: boolean }) {
      // With no files this behaves as `import list`, which is what people try first.
      if (files.length === 0) {
        await this.parseAsync(['list'], { from: 'user' });
        return;
      }
      try {
        const root = await projectRoot(this);
        const imported: SourceVideo[] = [];
        for (const file of files) {
          const video = await addVideo(root, file, { copy: options.copy });
          imported.push(video);
        }

        emit({ ok: true, videos: imported }, () => {
          for (const video of imported) {
            success(
              `Imported ${chalk.bold(path.basename(video.path))} — ${formatDuration(video.probe?.durationSeconds ?? 0)}${video.copied ? ' (copied)' : ''}`,
            );
          }
          say();
          say('Next: `reeleel athlete add --name <who> --focal`, then `reeleel analyze`.');
        });
      } catch (error) {
        fail(error);
      }
    });

  media
    .command('list')
    .aliases(['ls'])
    .description('list imported videos')
    .action(async function (this: Command) {
      try {
        const root = await projectRoot(this);
        const videos = await listVideos(root);

        emit({ ok: true, videos }, () => {
          if (videos.length === 0) {
            info('No videos imported yet. Add one with `reeleel import <file>`.');
            return;
          }
          table(videos, [
            { header: 'ID', value: (v) => v.id },
            { header: 'FILE', value: (v) => path.basename(v.path) },
            { header: 'DURATION', value: (v) => formatDuration(v.probe?.durationSeconds ?? 0) },
            {
              header: 'RESOLUTION',
              value: (v) =>
                v.probe?.video === undefined
                  ? '—'
                  : `${v.probe.video.width}x${v.probe.video.height}`,
            },
            { header: 'PROXY', value: (v) => (v.proxyPath === null ? chalk.dim('no') : 'yes') },
          ]);
        });
      } catch (error) {
        fail(error);
      }
    });

  media
    .command('update <ref>')
    .aliases(['set', 'edit'])
    .description('re-point a moved source file, reorder, or re-probe')
    .option('--path <file>', 'new location of the source file')
    .option('--order <n>', 'position in a multi-file game', Number)
    .option('--reprobe', 're-read media info with ffprobe', false)
    .action(
      async function (
        this: Command,
        ref: string,
        options: { path?: string; order?: number; reprobe: boolean },
      ) {
        try {
          const root = await projectRoot(this);
          const video = await updateVideo(root, ref, {
            ...(options.path === undefined ? {} : { path: options.path }),
            ...(options.order === undefined ? {} : { order: options.order }),
            reprobe: options.reprobe,
          });
          emit({ ok: true, video }, () => {
            success(`Updated ${path.basename(video.path)}`);
          });
        } catch (error) {
          fail(error);
        }
      },
    );

  media
    .command('remove <ref>')
    .aliases(['rm', 'delete', 'del'])
    .description('remove a video and its derived data from the project')
    .option('--delete-file', 'also delete the media file (only if ReelEel copied it)', false)
    .action(async function (this: Command, ref: string, options: { deleteFile: boolean }) {
      try {
        const root = await projectRoot(this);
        const video = await removeVideo(root, ref, { deleteFile: options.deleteFile });
        emit({ ok: true, video }, () => {
          success(`Removed ${path.basename(video.path)}`);
          if (!options.deleteFile) info('The source file itself was left where it is.');
        });
      } catch (error) {
        fail(error);
      }
    });

  media
    .command('proxy <ref>')
    .description('generate a low-resolution editing proxy')
    .option('--height <px>', 'proxy height in pixels', Number, 540)
    .action(async function (this: Command, ref: string, options: { height: number }) {
      try {
        const root = await projectRoot(this);
        const video = await getVideo(root, ref);
        const output = await generateProxy(root, video, { height: options.height });
        emit({ ok: true, proxy: output }, () => success(`Proxy written to ${output}`));
      } catch (error) {
        fail(error);
      }
    });

  media
    .command('thumbnails <ref>')
    .aliases(['thumbs'])
    .description('generate scrub thumbnails')
    .option('--count <n>', 'how many frames', Number, 60)
    .action(async function (this: Command, ref: string, options: { count: number }) {
      try {
        const root = await projectRoot(this);
        const video = await getVideo(root, ref);
        const result = await generateThumbnails(root, video, { count: options.count });
        emit({ ok: true, ...result }, () =>
          success(`Wrote ${result.files.length} thumbnails to ${result.dir}`),
        );
      } catch (error) {
        fail(error);
      }
    });

  media
    .command('check')
    .aliases(['verify'])
    .description('report source files that have moved or disappeared')
    .action(async function (this: Command) {
      try {
        const root = await projectRoot(this);
        const missing = await findMissingSources(root);
        emit({ ok: missing.length === 0, missing }, () => {
          if (missing.length === 0) {
            success('Every source file is where the project expects it.');
            return;
          }
          warn(`${missing.length} source file(s) are missing:`);
          for (const video of missing) {
            say(`  ${video.id}  ${video.path}`);
          }
          info(`Re-point one with: reeleel import update <id> --path <new location>`);
        });
      } catch (error) {
        fail(error);
      }
    });
};
