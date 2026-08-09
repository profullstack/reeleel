import chalk from 'chalk';
import type { Command } from 'commander';

import {
  DATASET_FORMATS,
  addModel,
  exportDataset,
  getModel,
  importDataset,
  listModels,
  removeModel,
  updateModel,
  verifyModel,
} from '@reeleel/core';
import type { DatasetFormat } from '@reeleel/core';

import { collect, projectRoot } from '../context.js';
import { emit, fail, heading, info, say, success, table, warn } from '../output.js';

const isFormat = (value: string): value is DatasetFormat =>
  (DATASET_FORMATS as readonly string[]).includes(value);

export const registerDataCommands = (program: Command): void => {
  const dataset = program
    .command('dataset')
    .aliases(['data'])
    .description('export and import annotation datasets for training');

  dataset
    .command('export [ref]')
    .description('export annotations as COCO, YOLO or ReelEel JSON')
    .option('--format <format>', `one of: ${DATASET_FORMATS.join(', ')}`, 'coco')
    .option('--output <dir>', 'output directory', './dataset')
    .option('--train <ratio>', 'training split', Number, 0.7)
    .option('--val <ratio>', 'validation split', Number, 0.2)
    .option('--test <ratio>', 'test split', Number, 0.1)
    .option('--seed <seed>', 'split seed (defaults to the project id)')
    .option('--video <id>', 'restrict to specific videos (repeatable)', collect)
    .option('--include-out-of-frame', 'include boxes flagged out of frame', false)
    .action(
      async function (
        this: Command,
        ref: string | undefined,
        options: {
          format: string;
          output: string;
          train: number;
          val: number;
          test: number;
          seed?: string;
          video?: string[];
          includeOutOfFrame: boolean;
        },
      ) {
        try {
          if (!isFormat(options.format)) {
            warn(`Unknown format "${options.format}". Valid: ${DATASET_FORMATS.join(', ')}`);
            process.exitCode = 1;
            return;
          }

          const root = await projectRoot(this, ref);
          const result = await exportDataset(root, options.format, options.output, {
            ratios: { train: options.train, val: options.val, test: options.test },
            ...(options.seed === undefined ? {} : { seed: options.seed }),
            ...(options.video === undefined ? {} : { videoIds: options.video }),
            includeOutOfFrame: options.includeOutOfFrame,
          });

          emit({ ok: true, ...result }, () => {
            success(`Exported ${result.annotationCount} annotation(s) as ${result.format}.`);
            say(`  ${result.outputDir}`);
            say(
              `  splits: train ${result.splits.train}, val ${result.splits.val}, test ${result.splits.test}`,
            );
            // Worth repeating: split leakage is the classic way to fool yourself.
            info('Splits are by video, not by frame, so adjacent frames cannot leak across them.');
          });
        } catch (error) {
          fail(error);
        }
      },
    );

  dataset
    .command('import <path> [ref]')
    .description('import annotations from COCO, YOLO or ReelEel JSON')
    .option('--format <format>', `one of: ${DATASET_FORMATS.join(', ')}`, 'coco')
    .action(
      async function (
        this: Command,
        inputPath: string,
        ref: string | undefined,
        options: { format: string },
      ) {
        try {
          if (!isFormat(options.format)) {
            warn(`Unknown format "${options.format}".`);
            process.exitCode = 1;
            return;
          }
          const root = await projectRoot(this, ref);
          const result = await importDataset(root, options.format, inputPath);
          emit({ ok: true, ...result }, () => {
            success(`Imported ${result.imported} annotation(s).`);
            if (result.skipped > 0) {
              warn(`${result.skipped} entr(ies) were skipped — unknown video or malformed box.`);
            }
          });
        } catch (error) {
          fail(error);
        }
      },
    );

  const models = program
    .command('models')
    .aliases(['model'])
    .description('the local model registry');

  models
    .command('list', { isDefault: true })
    .aliases(['ls'])
    .description('list registered models')
    .option('--sport <sport>', 'filter by sport')
    .action(async (options: { sport?: string }) => {
      try {
        const list = await listModels(options.sport === undefined ? {} : { sport: options.sport });
        emit({ ok: true, models: list }, () => {
          if (list.length === 0) {
            info('No models registered.');
            say(
              chalk.dim(
                '  Register one with: reeleel models add <name> --version <v> --sport soccer --file <weights> --license <spdx>',
              ),
            );
            return;
          }
          table(list, [
            { header: 'NAME', value: (m) => m.name },
            { header: 'VERSION', value: (m) => m.version },
            { header: 'SPORT', value: (m) => m.sport },
            { header: 'RUNTIME', value: (m) => m.runtime },
            {
              header: 'LICENSE',
              value: (m) => (m.license === 'unknown' ? chalk.yellow('unknown') : m.license),
            },
          ]);
        });
      } catch (error) {
        fail(error);
      }
    });

  models
    .command('add <name>')
    .aliases(['install', 'register'])
    .description('register a model in the local registry')
    .requiredOption('--version <version>', 'model version')
    .requiredOption('--sport <sport>', 'which sport it detects')
    .option('--file <weights>', 'weights file to copy into the model store')
    .option('--link', 'reference the weights in place instead of copying', false)
    .option('--architecture <name>', 'model architecture')
    .option('--runtime <name>', 'onnx, torch, …', 'onnx')
    .option('--license <spdx>', 'weights license — required for redistribution clarity')
    .option('--classes <list>', 'comma-separated class names', collect)
    .option('--dataset-version <version>', 'dataset the model was trained on')
    .action(
      async (
        name: string,
        options: {
          version: string;
          sport: string;
          file?: string;
          link: boolean;
          architecture?: string;
          runtime: string;
          license?: string;
          classes?: string[];
          datasetVersion?: string;
        },
      ) => {
        try {
          const created = await addModel({
            name,
            version: options.version,
            sport: options.sport,
            ...(options.file === undefined ? {} : { file: options.file }),
            link: options.link,
            ...(options.architecture === undefined ? {} : { architecture: options.architecture }),
            runtime: options.runtime,
            ...(options.license === undefined ? {} : { license: options.license }),
            ...(options.classes === undefined ? {} : { classes: options.classes }),
            ...(options.datasetVersion === undefined
              ? {}
              : { datasetVersion: options.datasetVersion }),
          });

          emit({ ok: true, model: created }, () => {
            success(`Registered ${chalk.bold(`${created.name}@${created.version}`)}`);
            if (created.license === 'unknown') {
              warn(
                'No license recorded. A FOSS framework does not make its weights redistributable — record the license before shipping this.',
              );
            }
          });
        } catch (error) {
          fail(error);
        }
      },
    );

  models
    .command('show <ref>')
    .aliases(['info'])
    .description('show one model (accepts name or name@version)')
    .action(async (ref: string) => {
      try {
        const model = await getModel(ref);
        emit({ ok: true, model }, () => {
          heading(`${model.name}@${model.version}`);
          say(`  sport        ${model.sport}`);
          say(`  architecture ${model.architecture}`);
          say(`  runtime      ${model.runtime}`);
          say(`  license      ${model.license}`);
          say(`  classes      ${model.classes.join(', ') || '—'}`);
          say(`  weights      ${model.path ?? '(none registered)'}`);
          say(`  checksum     ${model.checksum ?? '—'}`);
          if (model.datasetVersion !== null) say(`  dataset      ${model.datasetVersion}`);
          const metrics = Object.entries(model.metrics);
          if (metrics.length > 0) {
            say(`  metrics      ${metrics.map(([k, v]) => `${k}=${v}`).join(', ')}`);
          }
        });
      } catch (error) {
        fail(error);
      }
    });

  models
    .command('update <ref>')
    .aliases(['set', 'edit'])
    .description('update a model\'s metadata or re-point its weights')
    .option('--license <spdx>', 'weights license')
    .option('--architecture <name>', 'model architecture')
    .option('--runtime <name>', 'onnx, torch, …')
    .option('--classes <list>', 'comma-separated class names', collect)
    .option('--dataset-version <version>', 'dataset version ("" clears it)')
    .option('--path <file>', 'new weights location (re-checksums)')
    .action(
      async (
        ref: string,
        options: {
          license?: string;
          architecture?: string;
          runtime?: string;
          classes?: string[];
          datasetVersion?: string;
          path?: string;
        },
      ) => {
        try {
          const updated = await updateModel(ref, {
            ...(options.license === undefined ? {} : { license: options.license }),
            ...(options.architecture === undefined ? {} : { architecture: options.architecture }),
            ...(options.runtime === undefined ? {} : { runtime: options.runtime }),
            ...(options.classes === undefined ? {} : { classes: options.classes }),
            ...(options.datasetVersion === undefined
              ? {}
              : {
                  datasetVersion:
                    options.datasetVersion.length === 0 ? null : options.datasetVersion,
                }),
            ...(options.path === undefined ? {} : { path: options.path }),
          });
          emit({ ok: true, model: updated }, () =>
            success(`Updated ${updated.name}@${updated.version}`),
          );
        } catch (error) {
          fail(error);
        }
      },
    );

  models
    .command('remove <ref>')
    .aliases(['rm', 'delete', 'del', 'uninstall'])
    .description('remove a model from the registry')
    .option('--purge', 'also delete the weights from the model store', false)
    .action(async (ref: string, options: { purge: boolean }) => {
      try {
        const removed = await removeModel(ref, { purge: options.purge });
        emit({ ok: true, model: removed }, () => {
          success(`Removed ${removed.name}@${removed.version}`);
          if (!options.purge && removed.path !== null) info(`Weights kept at ${removed.path}`);
        });
      } catch (error) {
        fail(error);
      }
    });

  models
    .command('verify <ref>')
    .aliases(['check'])
    .description('confirm a model\'s weights are present and unmodified')
    .action(async (ref: string) => {
      try {
        const result = await verifyModel(ref);
        emit({ ...result, ok: result.ok }, () => {
          if (result.ok) {
            success(`${result.model.name}@${result.model.version} verified.`);
            return;
          }
          warn(result.reason ?? 'Verification failed.');
        });
        if (!result.ok) process.exitCode = 1;
      } catch (error) {
        fail(error);
      }
    });
};
