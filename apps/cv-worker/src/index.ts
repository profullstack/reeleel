#!/usr/bin/env node
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { availableParallelism, cpus } from 'node:os';
import { fileURLToPath } from 'node:url';

import { probe, requireBinary } from '@reeleel/core';

import {
  COCO_TO_SPORT,
  classSidecarPath,
  mappingFor,
  parseModelSidecar,
} from './classes.js';
import { DEFAULT_MODEL, defaultModelPath, fetchModel, resolveModelPath } from './models.js';
import { runPipeline } from './pipeline.js';
import { computeSignatures } from './signatures.js';
import type { SignatureBox } from './signatures.js';

/** Minimal flag parsing — the protocol is fixed and this has no users but us. */
export const parseArgs = (argv: string[]): { command: string; flags: Record<string, string>; bare: Set<string> } => {
  const [command = 'help', ...rest] = argv;
  const flags: Record<string, string> = {};
  const bare = new Set<string>();

  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (token === undefined || !token.startsWith('--')) continue;
    const name = token.slice(2);
    const next = rest[i + 1];
    if (next === undefined || next.startsWith('--')) {
      bare.add(name);
    } else {
      flags[name] = next;
      i += 1;
    }
  }
  return { command, flags, bare };
};

const number = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

/**
 * How many threads onnxruntime should use for one inference.
 *
 * Left to itself (`intraOpNumThreads: 0`) onnxruntime sizes its pool from the
 * cores it can see — and inside a container that is usually the *host's* core
 * count, not the cgroup's share of it. Oversubscribing is not a mild loss:
 * measured on a 4-core machine, YOLOX-Tiny at 416x416 runs 56 ms/frame with a
 * sensible pool and 194 ms/frame with eight threads, so a container given two
 * vCPUs on a large host can end up several times slower than the hardware
 * allows, invisibly.
 *
 * `os.availableParallelism()` is cgroup-aware, which `os.cpus().length` is not.
 * Two threads measured fastest and four were close; more than four only ever
 * cost time, so the pool is capped there.
 */
const defaultThreads = (): number => {
  const override = Number(process.env['REELEEL_CV_THREADS']);
  if (Number.isFinite(override) && override > 0) return Math.floor(override);
  // Production reported `cgroup-aware 24, visible cores 48`, so the old cap of
  // four was leaving twenty cores idle. The cap now reflects where a model this
  // small stops benefiting rather than the size of the box it was tuned on;
  // REELEEL_CV_THREADS overrides it without a deploy.
  return Math.max(1, Math.min(8, availableParallelism()));
};

/** Data on stdout, diagnostics on stderr — the host parses stdout as one object. */
const emit = (payload: unknown): void => {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
};

const capabilities = (): void => {
  emit({
    version: '0.1.0',
    implemented: true,
    runtime: 'onnxruntime-node',
    backends: ['cpu'],
    trackers: ['bytetrack'],
    sports: Object.keys(COCO_TO_SPORT),
    defaultModel: {
      name: DEFAULT_MODEL.name,
      version: DEFAULT_MODEL.version,
      license: DEFAULT_MODEL.license,
      url: DEFAULT_MODEL.url,
    },
    // Stated plainly so nobody expects roles or targets this model cannot know.
    producesBySport: Object.fromEntries(
      Object.entries(COCO_TO_SPORT).map(([sport, table]) => [
        sport,
        [...new Set(Object.values(table))],
      ]),
    ),
    cannotProduce: ['any role (referee, goalkeeper, umpire)', 'any target (goal, hoop, net, base)'],
  });
};

const detectAndTrack = async (flags: Record<string, string>): Promise<void> => {
  const input = flags['input'];
  if (input === undefined) {
    emit({ error: '--input is required.' });
    return;
  }

  const sport = flags['sport'] ?? 'soccer';
  const requested = (flags['classes'] ?? '').split(',').map((c) => c.trim()).filter(Boolean);

  const modelPath = resolveModelPath({ explicit: flags['model'], sport });
  if (modelPath === null) {
    emit({
      error:
        `No detection model found for ${sport}. Download the default one with ` +
        `\`reeleel-cv fetch-model --sport ${sport}\` (${DEFAULT_MODEL.name}, ` +
        `${DEFAULT_MODEL.license}), or point at your own with --model / REELEEL_CV_MODEL. ` +
        `Expected at ${defaultModelPath(sport)}.`,
    });
    return;
  }

  // Same classes the pipeline will use, or this reports on the wrong model.
  const sidecarPath = classSidecarPath(modelPath);
  const declared = existsSync(sidecarPath)
    ? parseModelSidecar(readFileSync(sidecarPath, 'utf8')).classes
    : null;

  const mapping = mappingFor(sport, requested, declared);
  if (mapping.produces.length === 0) {
    emit({ error: `This model cannot detect any of: ${requested.join(', ') || '(none requested)'}.` });
    return;
  }

  const threads = number(flags['threads'], defaultThreads());
  // Reported before the run, not after: a detection pass takes minutes and can
  // fail, and a diagnostic that only prints on success is no use in either
  // case. If the two counts disagree, onnxruntime left to itself would have
  // sized its pool from the wrong one — the reason threads are pinned at all.
  process.stderr.write(
    `threads: using ${threads} ` +
      `(cgroup-aware ${availableParallelism()}, visible cores ${cpus().length})\n`,
  );

  const media = await probe(input);
  const width = media.video?.width ?? 0;
  const height = media.video?.height ?? 0;
  if (width <= 0 || height <= 0) {
    emit({ error: `${input} has no readable video stream.` });
    return;
  }

  const controller = new AbortController();
  const onSignal = (): void => controller.abort();
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  try {
    const started = Date.now();
    const result = await runPipeline({
      input,
      modelPath,
      sport,
      classes: requested,
      frameStride: number(flags['frame-stride'], 2),
      inferenceSize: number(flags['inference-size'], DEFAULT_MODEL.inputSize),
      // Off unless asked for: it costs grid^2 + 1 inferences per frame.
      tileGrid: number(flags['tile-grid'], 1),
      minConfidence: number(flags['min-confidence'], 0.3),
      iouThreshold: number(flags['iou'], 0.45),
      sourceWidth: width,
      sourceHeight: height,
      fps: media.video?.fps ?? 0,
      threads,
      signal: controller.signal,
      onProgress: (frames) => {
        if (frames % 50 === 0) process.stderr.write(`analyzed ${frames} frames\n`);
      },
    });


    process.stderr.write(
      `done: ${result.framesProcessed} frames, ${result.detections} detections, ` +
        `${result.tracks.length} tracks in ${Math.round((Date.now() - started) / 1000)}s\n`,
    );
    if (result.unsupportedClasses.length > 0) {
      process.stderr.write(
        `note: this model cannot detect ${result.unsupportedClasses.join(', ')}; ` +
          'those classes need a sport-specific model.\n',
      );
    }

    emit({ tracks: result.tracks });
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
};

/** Reads the whole of stdin, which is how a box list arrives. */
const readStdin = async (): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
};

/**
 * Colour signatures for a list of boxes, so the host can tell whether two
 * tracks are the same child. Boxes arrive on stdin because there can be
 * thousands of them and an argv has limits.
 */
const appearance = async (flags: Record<string, string>): Promise<void> => {
  const input = flags['input'];
  if (input === undefined) {
    emit({ error: '--input is required.' });
    return;
  }

  interface Request {
    boxes?: SignatureBox[];
    /** The pixel space the boxes are in — see below. */
    sourceWidth?: number;
    sourceHeight?: number;
  }
  let request: Request;
  try {
    request = JSON.parse(await readStdin()) as Request;
  } catch (cause) {
    emit({ error: `stdin was not the JSON box list this expects: ${String(cause)}` });
    return;
  }
  const boxes = request.boxes ?? [];
  if (boxes.length === 0) {
    emit({ error: 'No boxes were given, so there is nothing to measure.' });
    return;
  }

  const media = await probe(input);
  /**
   * The boxes' coordinate space travels with the boxes, and is not the same
   * thing as the size of the file being decoded.
   *
   * Tracks are stored in source-video pixels, but this reads the 540p proxy
   * because a shirt's colour survives that and decodes in a fraction of the
   * time. Taking the space from the decoded file measured every torso against
   * the wrong scale — crops landed off the edge of the frame, signatures came
   * back empty or meaningless, and the result was a confident zero matches on
   * footage where eight were there to be found.
   */
  const width = request.sourceWidth ?? media.video?.width ?? 0;
  const height = request.sourceHeight ?? media.video?.height ?? 0;
  if (width <= 0 || height <= 0) {
    emit({ error: `${input} has no readable video stream.` });
    return;
  }

  const controller = new AbortController();
  const onSignal = (): void => controller.abort();
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  try {
    const started = Date.now();
    const result = await computeSignatures({
      input,
      ffmpegPath: requireBinary('ffmpeg'),
      sourceWidth: width,
      sourceHeight: height,
      fps: media.video?.fps ?? 0,
      boxes,
      samplesPerSecond: number(flags['samples-per-second'], 2),
      decodeWidth: number(flags['decode-width'], 960),
      signal: controller.signal,
    });
    process.stderr.write(
      `signatures: ${Object.keys(result.signatures).length} track(s) from ` +
        `${result.framesRead} frames in ${Math.round((Date.now() - started) / 1000)}s\n`,
    );
    emit({ signatures: result.signatures, pixels: result.pixels });
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
};

const fetch = async (flags: Record<string, string>): Promise<void> => {
  const sport = flags['sport'] ?? 'soccer';
  const url = flags['url'] ?? DEFAULT_MODEL.url;
  const destination = flags['output'] ?? defaultModelPath(sport);

  process.stderr.write(`downloading ${url}\n`);
  const result = await fetchModel(url, destination, (received, total) => {
    if (total !== null && received % (4 * 1024 * 1024) < 65536) {
      process.stderr.write(`  ${Math.round((received / total) * 100)}%\n`);
    }
  });

  process.stderr.write(`saved ${result.bytes} bytes to ${result.path}\n`);
  emit({
    ...result,
    name: DEFAULT_MODEL.name,
    version: DEFAULT_MODEL.version,
    license: DEFAULT_MODEL.license,
    architecture: DEFAULT_MODEL.architecture,
    register: `reeleel models add ${DEFAULT_MODEL.name} --version ${DEFAULT_MODEL.version} --sport ${sport} --file ${result.path} --license ${DEFAULT_MODEL.license} --link`,
  });
};

export const main = async (argv: string[]): Promise<number> => {
  const { command, flags } = parseArgs(argv);

  try {
    switch (command) {
      case 'detect-and-track':
        await detectAndTrack(flags);
        return 0;
      case 'appearance':
        await appearance(flags);
        return 0;
      case 'capabilities':
        capabilities();
        return 0;
      case 'fetch-model':
        await fetch(flags);
        return 0;
      default:
        process.stderr.write(
          'usage: reeleel-cv <detect-and-track|appearance|capabilities|fetch-model> [options]\n' +
            'see workers/cv/README.md for the protocol\n',
        );
        return command === 'help' ? 0 : 1;
    }
  } catch (error) {
    emit({ error: error instanceof Error ? error.message : String(error) });
    return 1;
  }
};

const isEntryPoint = (): boolean => {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
};

if (isEntryPoint()) process.exitCode = await main(process.argv.slice(2));
