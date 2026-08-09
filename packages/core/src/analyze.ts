import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from './config.js';
import { changes, execute, projectDb } from './db.js';
import { ReelEelError } from './errors.js';
import { run } from './ffmpeg.js';
import { createJob, logJob, updateJob } from './jobs.js';
import { getFocalAthlete } from './athletes.js';
import { generateMoments } from './moments.js';
import { generateProxy, generateThumbnails } from './media.js';
import { readManifest } from './projects.js';
import { createTrack } from './tracks.js';
import type { Job, Preset } from './types.js';
import { findMissingSources, listVideos } from './videos.js';

import { getSport, requiredClasses } from '@reeleel/sports';

export interface PresetSettings {
  /** Run the detector on every Nth frame; gaps are filled by the tracker. */
  frameStride: number;
  /** Longest side fed to the detector, in pixels. */
  inferenceSize: number;
  minConfidence: number;
  /** Analyze the proxy instead of the original. */
  useProxy: boolean;
}

export const PRESET_SETTINGS: Record<Exclude<Preset, 'custom'>, PresetSettings> = {
  // CPU-only is a hard requirement, so "fast" has to be genuinely cheap.
  fast: { frameStride: 5, inferenceSize: 512, minConfidence: 0.35, useProxy: true },
  balanced: { frameStride: 2, inferenceSize: 768, minConfidence: 0.3, useProxy: true },
  accurate: { frameStride: 1, inferenceSize: 1280, minConfidence: 0.25, useProxy: false },
};

export const settingsForPreset = (preset: Preset): PresetSettings => {
  if (preset === 'custom') {
    const config = loadConfig();
    return {
      frameStride: Math.max(1, config.analysis.sampleEveryNthFrame),
      inferenceSize: 768,
      minConfidence: 0.3,
      useProxy: true,
    };
  }
  return PRESET_SETTINGS[preset];
};

/**
 * The CV worker is a separate process (Python + PyTorch/ONNX) so that a crash,
 * an OOM, or a wedged GPU backend takes down the worker rather than the app.
 * Resolution order: explicit override, an installed `reeleel-cv` on PATH, then
 * the in-repo worker run through Python.
 */
export interface CvWorker {
  command: string;
  args: string[];
  kind: 'binary' | 'python' | 'node';
}

export const resolveCvWorker = (): CvWorker | null => {
  const override = process.env['REELEEL_CV_WORKER'];
  if (override !== undefined && override.length > 0) {
    return override.endsWith('.js')
      ? { command: process.execPath, args: [override], kind: 'node' }
      : { command: override, args: [], kind: 'binary' };
  }

  const onPath = process.env['PATH']?.split(path.delimiter) ?? [];
  for (const dir of onPath) {
    const candidate = path.join(dir, process.platform === 'win32' ? 'reeleel-cv.exe' : 'reeleel-cv');
    if (existsSync(candidate)) return { command: candidate, args: [], kind: 'binary' };
  }

  // The in-repo worker, located relative to this module rather than the current
  // directory — core is called from the CLI, the API and the web app, and only
  // one of those reliably runs from the repository root.
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = path.join(dir, 'apps', 'cv-worker', 'dist', 'index.js');
    if (existsSync(candidate)) {
      return { command: process.execPath, args: [candidate], kind: 'node' };
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  const pythonWorker = path.resolve(process.cwd(), 'workers', 'cv', 'reeleel_cv', '__main__.py');
  if (existsSync(pythonWorker)) {
    const python = process.env['REELEEL_PYTHON'] ?? 'python3';
    return { command: python, args: [pythonWorker], kind: 'python' };
  }

  return null;
};

interface WorkerTrackPoint {
  frame: number;
  ts: number;
  x: number;
  y: number;
  w: number;
  h: number;
  confidence: number;
}

interface WorkerTrack {
  class: string;
  confidence: number;
  points: WorkerTrackPoint[];
}

interface WorkerOutput {
  tracks?: WorkerTrack[];
  error?: string;
}

export interface AnalyzeOptions {
  preset?: Preset;
  videoId?: string;
  /** Skip proxy/thumbnail generation when they already exist. */
  skipMedia?: boolean;
  /** Re-score existing tracks without re-running detection. */
  scoreOnly?: boolean;
  signal?: AbortSignal;
  onStage?: (stage: string, detail?: string) => void;
  /**
   * Called once the job row exists, before any work starts. The caller needs
   * the id at that moment to be able to cancel the run it just kicked off;
   * waiting for the returned result means waiting for the thing it wants to
   * interrupt.
   */
  onStart?: (job: Job) => void;
}

export interface AnalyzeResult {
  job: Job;
  stagesRun: string[];
  tracksCreated: number;
  momentsGenerated: number;
  warnings: string[];
}

/**
 * Runs the analysis pipeline. Every stage records progress on a job row, so an
 * interrupted run is visible afterwards and can be retried instead of silently
 * restarting from zero.
 */
export const analyzeProject = async (
  root: string,
  options: AnalyzeOptions = {},
): Promise<AnalyzeResult> => {
  const manifest = readManifest(root);
  const plugin = getSport(manifest.sport);
  if (plugin === null) {
    throw new ReelEelError('SPORT_UNKNOWN', `Project sport "${manifest.sport}" is not installed.`);
  }

  const preset = options.preset ?? loadConfig().analysis.preset;
  const settings = settingsForPreset(preset);
  const warnings: string[] = [];
  const stagesRun: string[] = [];

  const missing = await findMissingSources(root);
  if (missing.length > 0) {
    throw new ReelEelError(
      'SOURCE_MISSING',
      `${missing.length} source file(s) are no longer where they were imported from.`,
      {
        hint: `Re-point one with: reeleel import update ${missing[0]?.id ?? '<id>'} --path <new location>`,
        details: { paths: missing.map((video) => video.path) },
      },
    );
  }

  const videos = (await listVideos(root)).filter(
    (video) => options.videoId === undefined || video.id === options.videoId,
  );
  if (videos.length === 0) {
    throw new ReelEelError('NOT_FOUND', 'Nothing to analyze — this project has no video.', {
      hint: 'Add one with `reeleel import <file>`.',
    });
  }

  const job = await createJob(root, 'detection', { preset, videoIds: videos.map((v) => v.id) });

  /**
   * Said before the work, not after it.
   *
   * Three of the seven scoring signals need a focal track, and together they
   * carry 0.6 of the 1.15 total weight. Without one the only signal that can
   * fire is high_motion at 0.1, so the highest score any window can reach is
   * 0.087 — against a threshold of 0.35. Not "unlikely": arithmetically
   * impossible. Spending a minute of detection to prove that, and then
   * reporting "completed", is the least useful thing this could do.
   */
  if ((await getFocalAthlete(root)) === null) {
    await logJob(
      root,
      job.id,
      'No athlete is marked to follow. Scoring cannot reach the ' +
        `${plugin.moments.minScore} threshold without one — the focal signals carry most of the ` +
        'weight, so this run will find tracks but suggest nothing. Mark an athlete and run again.',
      'warn',
    );
  }
  options.onStart?.(job);
  const stage = async (name: string, progress: number, detail?: string): Promise<void> => {
    options.onStage?.(name, detail);
    await updateJob(root, job.id, { status: 'running', stage: name, progress });
    await logJob(root, job.id, detail === undefined ? name : `${name}: ${detail}`);
  };

  let tracksCreated = 0;
  let momentsGenerated = 0;

  try {
    if (options.scoreOnly !== true) {
      if (options.skipMedia !== true) {
        for (const [index, video] of videos.entries()) {
          const share = (index + 1) / videos.length;
          await stage('proxy', 0.1 * share, path.basename(video.path));
          if (video.proxyPath === null || !existsSync(video.proxyPath)) {
            await generateProxy(
              root,
              video,
              options.signal === undefined ? {} : { signal: options.signal },
            );
          }
          await stage('thumbnails', 0.2 * share, path.basename(video.path));
          if (video.thumbnailDir === null || !existsSync(video.thumbnailDir)) {
            await generateThumbnails(
              root,
              video,
              options.signal === undefined ? {} : { signal: options.signal },
            );
          }
        }
        stagesRun.push('proxy', 'thumbnails');
      }

      const worker = resolveCvWorker();
      if (worker === null) {
        throw new ReelEelError('WORKER_MISSING', 'The ReelEel CV worker is not installed.', {
          hint:
            'Detection and tracking run in a separate Python process. Install it with ' +
            '`pip install -e workers/cv`, or point at one with REELEEL_CV_WORKER. ' +
            'Everything else (import, probe, review, trim, export) works without it.',
        });
      }

      // Re-read videos so proxy paths written above are visible.
      const refreshed = (await listVideos(root)).filter((video) =>
        videos.some((candidate) => candidate.id === video.id),
      );

      for (const [index, video] of refreshed.entries()) {
        const share = (index + 1) / refreshed.length;
        await stage('detection', 0.2 + 0.5 * share, path.basename(video.path));

        const input =
          settings.useProxy && video.proxyPath !== null && existsSync(video.proxyPath)
            ? video.proxyPath
            : video.path;

        /**
         * Detection is the long pole — minutes of CPU inference on a full game
         * — and it used to report progress once, when it started. The bar sat
         * at 70% for the entire pass, which is indistinguishable from a hang
         * and was reported as one.
         *
         * The worker has always written `analyzed N frames` to its stderr; the
         * lines were collected into a string and discarded on success. Reading
         * them turns the dead stretch into a moving bar with an ETA.
         */
        const detectionStart = 0.2 + 0.5 * (index / refreshed.length);
        const detectionSpan = 0.5 / refreshed.length;
        const fps = video.probe?.video?.fps ?? 0;
        const durationSeconds = video.probe?.durationSeconds ?? 0;
        const expectedFrames =
          fps > 0 && durationSeconds > 0
            ? Math.max(1, Math.floor((durationSeconds * fps) / settings.frameStride))
            : 0;

        const startedAt = Date.now();
        let lastProgressAt = 0;
        let lastLogAt = 0;

        const onStderr = (chunk: string): void => {
          /**
           * The worker says useful things on stderr besides progress — which
           * thread pool it chose, that it overrode the requested input size,
           * which classes this model cannot produce. run() collects all of it
           * into a string that is only ever read when the run *fails*, so on a
           * successful run those lines reached nobody at all. They belong in
           * the job log, where the person watching already is.
           */
          for (const line of chunk.split('\n')) {
            const text = line.trim();
            if (text.length === 0 || text.startsWith('analyzed ')) continue;
            void logJob(root, job.id, `worker: ${text}`, text.startsWith('note:') ? 'warn' : 'info')
              .catch(() => undefined);
          }

          // A chunk can carry several lines; only the newest count matters.
          let frames: number | null = null;
          for (const match of chunk.matchAll(/analyzed (\d+) frames/g)) {
            frames = Number(match[1]);
          }
          if (frames === null) return;

          const now = Date.now();
          const elapsed = (now - startedAt) / 1000;
          const rate = elapsed > 0 ? frames / elapsed : 0;

          // Writing per line would hammer SQLite for no benefit; the feed polls
          // at a slower cadence than this anyway.
          if (now - lastProgressAt >= 2000) {
            lastProgressAt = now;
            const fraction = expectedFrames > 0 ? Math.min(1, frames / expectedFrames) : 0;
            const remaining =
              expectedFrames > 0 && rate > 0 ? Math.max(0, (expectedFrames - frames) / rate) : null;
            void updateJob(root, job.id, {
              status: 'running',
              stage: 'detection',
              progress: detectionStart + detectionSpan * fraction,
              etaSeconds: remaining === null ? null : Math.round(remaining),
            }).catch(() => undefined);
          }

          // The log is read by a human, so it moves at human speed.
          if (now - lastLogAt >= 15_000) {
            lastLogAt = now;
            const of = expectedFrames > 0 ? ` of ~${expectedFrames}` : '';
            void logJob(
              root,
              job.id,
              `detection: ${path.basename(input)} — ${frames}${of} frames at ${rate.toFixed(1)}/s`,
            ).catch(() => undefined);
          }
        };

        const result = await run(
          worker.command,
          [
            ...worker.args,
            'detect-and-track',
            '--input',
            input,
            '--sport',
            manifest.sport,
            '--classes',
            requiredClasses(plugin).join(','),
            '--frame-stride',
            String(settings.frameStride),
            '--inference-size',
            String(settings.inferenceSize),
            '--min-confidence',
            String(settings.minConfidence),
            '--tracker',
            plugin.tracker.algorithm,
            '--backend',
            loadConfig().analysis.backend,
            '--json',
          ],
          { onStderr, ...(options.signal === undefined ? {} : { signal: options.signal }) },
        );

        if (result.code !== 0) {
          // The worker reports its reason as JSON on stdout and signals failure
          // through the exit code, so stderr is usually empty. Reading only
          // stderr threw the explanation away: production logged "The CV worker
          // failed on vid_….mp4." with nothing after it, while the worker had
          // said exactly which model was missing and how to fetch it.
          throw new ReelEelError('WORKER_CRASHED', `The CV worker failed on ${path.basename(input)}.`, {
            hint: cvWorkerError(result.stdout) ?? result.stderr.trim().split('\n').at(-1) ?? undefined,
            details: { exitCode: result.code },
          });
        }

        let parsed: WorkerOutput;
        try {
          parsed = JSON.parse(result.stdout) as WorkerOutput;
        } catch (cause) {
          throw new ReelEelError('WORKER_CRASHED', 'The CV worker returned output we could not parse.', {
            cause,
          });
        }
        if (parsed.error !== undefined) {
          throw new ReelEelError('WORKER_CRASHED', parsed.error);
        }

        // Detections come back in whatever resolution the worker saw. When that
        // was the proxy, scale the boxes back into source pixels so the Virtual
        // Cameraman crops the original at full resolution.
        const sourceHeight = video.probe?.video?.height ?? 0;
        const analyzedHeight = input === video.path ? sourceHeight : proxyHeight(video.proxyPath);
        const scale = analyzedHeight > 0 && sourceHeight > 0 ? sourceHeight / analyzedHeight : 1;

        for (const track of parsed.tracks ?? []) {
          await createTrack(root, {
            videoId: video.id,
            className: track.class,
            confidence: track.confidence,
            samples: track.points.map((point) => ({
              frame: point.frame,
              ts: point.ts,
              x: point.x * scale,
              y: point.y * scale,
              w: point.w * scale,
              h: point.h * scale,
              confidence: point.confidence,
            })),
          });
          tracksCreated += 1;
        }
      }
      stagesRun.push('detection', 'tracking');
    }

    await stage('scoring', 0.85);
    const scored = await generateMoments(root, { replace: true });
    momentsGenerated = scored.generated;
    if (scored.skippedVideos.length > 0) {
      warnings.push(
        `${scored.skippedVideos.length} video(s) had no tracks to score. Run detection first.`,
      );
    }
    stagesRun.push('scoring');

    /**
     * What the run actually produced.
     *
     * These numbers were computed and then discarded: analyzeProject returned
     * them, and the web action calls it as `void analyzeProject(...)`, so a run
     * that finished with nothing to show reported "completed" and nothing else.
     * "It says it's done but there are no suggestions" is not then a question
     * anyone can answer — zero moments from zero tracks and zero moments from
     * tracks that scored too low need entirely different fixes.
     */
    await logJob(
      root,
      job.id,
      `done: ${tracksCreated} track(s), ${momentsGenerated} suggested moment(s)`,
      momentsGenerated === 0 ? 'warn' : 'info',
    );
    if (momentsGenerated === 0) {
      await logJob(
        root,
        job.id,
        tracksCreated === 0
          ? 'No tracks were produced, so there was nothing to score. The detector found nothing it recognised in this footage.'
          : `Tracks were found but none scored above the ${plugin.moments.minScore} threshold for ${manifest.sport}.` +
              ' Marking an athlete to follow gives scoring an anchor and usually raises scores.',
        'warn',
      );
    }
    for (const warning of warnings) await logJob(root, job.id, warning, 'warn');

    const finished = await updateJob(root, job.id, {
      status: 'completed',
      stage: 'done',
      progress: 1,
    });
    return { job: finished, stagesRun, tracksCreated, momentsGenerated, warnings };
  } catch (error) {
    const canceled = error instanceof ReelEelError && error.code === 'JOB_CANCELED';
    const message = error instanceof Error ? error.message : String(error);
    const hint = error instanceof ReelEelError ? error.hint : undefined;
    const code = error instanceof ReelEelError ? `${error.code}: ` : '';

    // The reason goes in the log as well as the job row. A row that only says
    // "failed" leaves the user staring at a status with no way to find out
    // what happened — the same dead end as an upload that simply stops.
    await logJob(
      root,
      job.id,
      canceled ? 'Canceled.' : `${code}${message}${hint === undefined ? '' : ` — ${hint}`}`,
      canceled ? 'warn' : 'error',
    ).catch(() => undefined);

    await updateJob(root, job.id, {
      status: canceled ? 'canceled' : 'failed',
      error: message,
    });
    throw error;
  }
};

/**
 * Digs the worker's own explanation out of its stdout.
 *
 * The CV worker's protocol is "data on stdout, diagnostics on stderr", but a
 * *failure* is data: it emits `{"error": "..."}` on stdout and signals the
 * failure through its exit code, leaving stderr empty. A caller that inspects
 * only stderr therefore discards the one useful sentence — which is how
 * production came to log "The CV worker failed on vid_….mp4." and nothing else.
 */
export const cvWorkerError = (stdout: string): string | undefined => {
  const lines = stdout.trim().split('\n');
  // Scan from the end: the failure is the last thing the worker managed to say.
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim();
    if (line === undefined || line.length === 0) continue;
    try {
      const parsed = JSON.parse(line) as { error?: unknown };
      if (typeof parsed.error === 'string' && parsed.error.length > 0) return parsed.error;
    } catch {
      // Not JSON — the worker may have died before emitting anything.
    }
  }
  return undefined;
};

/** Proxy height encoded in the filename by `generateProxy` (`<id>_540p.mp4`). */
const proxyHeight = (proxyPath: string | null): number => {
  if (proxyPath === null) return 0;
  const match = /_([0-9]+)p\.mp4$/.exec(proxyPath);
  return match?.[1] === undefined ? 0 : Number(match[1]);
};

/** Clears cached analysis so the next run starts fresh. Manual moments survive. */
export const clearAnalysis = async (
  root: string,
): Promise<{ tracks: number; moments: number }> => {
  const db = await projectDb(root);
  const tracks = changes(await execute(db, 'DELETE FROM tracks'));
  const moments = changes(await execute(db, 'DELETE FROM suggested_moments WHERE manual = 0'));
  await execute(db, 'DELETE FROM detections');
  return { tracks, moments };
};
