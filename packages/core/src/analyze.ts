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
import { generateProxy, generateThumbnails, PROXY_HEIGHT } from './media.js';
import { readManifest } from './projects.js';
import { clearTracks, createTrack, rebindAthletes, snapshotAthleteBindings } from './tracks.js';
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
  /**
   * Slice each frame into this many tiles per axis and detect in each at the
   * model's native resolution. 1 leaves it off.
   *
   * The shipped detector has a fixed 416x416 input, so a whole 1080p frame is
   * scaled by 0.217 before it is seen. Players survive that; the ball does not
   * — measured at 0.54 confidence full-frame against 0.89 from a tile, with
   * frames the full-frame pass missed entirely coming back. It is opt-in
   * because it costs tiles^2 + 1 inferences per frame.
   */
  tileGrid: number;
  /**
   * Detection floors for classes that need a different standard from people,
   * as `class: confidence`.
   *
   * A basketball is a handful of pixels; a player fills a fifth of the frame.
   * Holding both to one threshold meant the ball was judged by what a person
   * needs. Measured over 20s of a real game at the shipped tile grid: dropping
   * only the ball to 0.08 took it from 173 sampled positions to 293, and the
   * rim from 316 to 403, at identical cost — while ball *track* count stayed
   * at 16, which is what distinguishes better recall from new phantoms.
   */
  classConfidence?: Record<string, number>;
}

/**
 * Small, fast-moving and low-contrast: the things a detector is legitimately
 * unsure about, and the two classes scoring most depends on.
 */
const SMALL_OBJECTS: Record<string, number> = { ball: 0.08, puck: 0.08, hoop: 0.15, net: 0.15 };

export const PRESET_SETTINGS: Record<Exclude<Preset, 'custom'>, PresetSettings> = {
  // CPU-only is a hard requirement, so "fast" has to be genuinely cheap.
  fast: {
    frameStride: 5,
    inferenceSize: 512,
    minConfidence: 0.35,
    useProxy: true,
    tileGrid: 1,
    classConfidence: SMALL_OBJECTS,
  },
  balanced: {
    frameStride: 2,
    inferenceSize: 768,
    minConfidence: 0.3,
    useProxy: true,
    tileGrid: 1,
    classConfidence: SMALL_OBJECTS,
  },
  accurate: {
    frameStride: 1,
    inferenceSize: 1280,
    minConfidence: 0.25,
    useProxy: false,
    tileGrid: 1,
    classConfidence: SMALL_OBJECTS,
  },
  /**
   * The one that can see the ball. Five inferences per frame instead of one,
   * so it is minutes rather than seconds — offered as a choice, not a default,
   * because nobody's existing runtime should regress silently.
   */
  thorough: {
    frameStride: 2,
    inferenceSize: 1280,
    minConfidence: 0.25,
    useProxy: false,
    /**
     * Two, not three. A 3x3 grid was measured against this same footage and was
     * *worse* for the thing tiling exists to find: 127 ball positions against
     * 173, and 100 rim positions against 316, for twice the runtime. Tiles get
     * smaller but the whole-frame pass downsamples further to feed them, and
     * the rim loses more than the ball gains.
     */
    tileGrid: 2,
    classConfidence: SMALL_OBJECTS,
  },
};

/**
 * Which file the detector should actually read.
 *
 * The proxy is only worth detecting from when it is at least as tall as the
 * frame the worker will hand the model. `useProxy` was obeyed unconditionally,
 * and the 540p editing proxy is shorter than every inference size above `fast`.
 * The worker decodes to its own input size regardless, so a 540p proxy was
 * *upscaled* — the same inference cost for strictly less picture. Measured on a
 * 1080p game, the identical preset found 145,975 detections across 3,948 tracks
 * from the source against 67,985 across 1,415 from the proxy; the ball, a
 * handful of pixels to begin with, is what goes first. The saving was only ever
 * decode time.
 */
export const detectionInputFor = (
  settings: PresetSettings,
  video: { path: string; proxyPath: string | null },
  proxyExists: boolean,
): { input: string; usedProxy: boolean; proxyTooSmall: boolean } => {
  const proxyTooSmall = settings.useProxy && settings.inferenceSize > PROXY_HEIGHT;
  const usedProxy =
    settings.useProxy && !proxyTooSmall && video.proxyPath !== null && proxyExists;
  return {
    input: usedProxy && video.proxyPath !== null ? video.proxyPath : video.path,
    usedProxy,
    proxyTooSmall,
  };
};

export const settingsForPreset = (preset: Preset): PresetSettings => {
  /**
   * The web form and the API both cast whatever string arrives into `Preset`
   * without checking it, so an unknown value used to index a record that does
   * not have it and crash on the first field access. Falling back keeps a
   * hand-crafted post from taking a run down.
   */
  if (preset !== 'custom' && PRESET_SETTINGS[preset] === undefined) {
    return PRESET_SETTINGS.balanced;
  }
  if (preset === 'custom') {
    const config = loadConfig();
    return {
      frameStride: Math.max(1, config.analysis.sampleEveryNthFrame),
      inferenceSize: 768,
      minConfidence: 0.3,
      useProxy: true,
      tileGrid: 1,
      classConfidence: SMALL_OBJECTS,
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
  /** Athlete bindings captured before a re-detection wipes their tracks. */
  let rememberedBindings: Awaited<ReturnType<typeof snapshotAthleteBindings>> = [];

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

  /**
   * Editing media, built when detection is not waiting on it.
   *
   * The proxy is a 540p transcode of the whole source. Detection only reads it
   * on `fast`, because every other preset infers at more pixels than the proxy
   * has (see {@link detectionInputFor}) — so for the presets people actually
   * run, this is minutes of ffmpeg standing between the user and the tracks,
   * producing a file that pass will not open.
   *
   * That is not merely wasteful, it is where a real run died: a 61-minute
   * upload spent its first three minutes transcoding, a deploy replaced the
   * container, and the job was lost at 10% having detected nothing. Ordering
   * detection first would have banked 1,648 tracks before the restart.
   */
  const buildMedia = async (from: number, span: number): Promise<void> => {
    if (options.skipMedia === true) return;
    for (const [index, video] of videos.entries()) {
      const share = (index + 1) / videos.length;
      await stage('proxy', from + span * 0.5 * share, path.basename(video.path));
      if (video.proxyPath === null || !existsSync(video.proxyPath)) {
        await generateProxy(root, video, options.signal === undefined ? {} : { signal: options.signal });
      }
      await stage('thumbnails', from + span * share, path.basename(video.path));
      if (video.thumbnailDir === null || !existsSync(video.thumbnailDir)) {
        await generateThumbnails(
          root,
          video,
          options.signal === undefined ? {} : { signal: options.signal },
        );
      }
    }
    stagesRun.push('proxy', 'thumbnails');
  };

  try {
    if (options.scoreOnly !== true) {
      /**
       * Only ahead of detection when detection is the thing that needs it.
       * Otherwise it runs after the tracks are safely written.
       */
      const detectionNeedsProxy = settings.useProxy && settings.inferenceSize <= PROXY_HEIGHT;
      if (detectionNeedsProxy) await buildMedia(0, 0.2);

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

        const choice = detectionInputFor(
          settings,
          video,
          video.proxyPath !== null && existsSync(video.proxyPath),
        );
        const input = choice.input;
        if (choice.proxyTooSmall) {
          await logJob(
            root,
            job.id,
            `detecting from the original: the ${PROXY_HEIGHT}p proxy is smaller than the ` +
              `${settings.inferenceSize}px this preset detects at, so it would only lose detail.`,
          );
        }

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
            '--tile-grid',
            String(settings.tileGrid),
            ...(settings.classConfidence === undefined
              ? []
              : [
                  '--class-confidence',
                  Object.entries(settings.classConfidence)
                    .map(([name, value]) => `${name}=${value}`)
                    .join(','),
                ]),
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

        /**
         * Replace, do not append. Detection used to add its tracks on top of
         * whatever was already there, so re-analysing a video scored it against
         * every previous run at once — including runs that were later found to
         * be broken. A project analysed six times carried six overlapping copies
         * of every player.
         */
        // Remembered before the delete, so the athlete can be found again in
        // the new tracks rather than re-identified by hand every single run.
        const bindings = await snapshotAthleteBindings(root, video.id);
        const cleared = await clearTracks(root, video.id);
        if (cleared.removed > 0) {
          await logJob(
            root,
            job.id,
            `replacing ${cleared.removed} track(s) from earlier runs of this video`,
          );
        }
        rememberedBindings = bindings;

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

      // The tracks are written; the editing transcode can have the machine now.
      if (!detectionNeedsProxy) await buildMedia(0.7, 0.1);

      /**
       * Find the athlete again in the new tracks. Positions survive a
       * re-detection even though ids do not, so the person standing where the
       * athlete stood, on the frames they stood there, is them.
       */
      if (rememberedBindings.length > 0) {
        const restored = await rebindAthletes(root, videos[0]?.id ?? '', rememberedBindings);
        const lost = rememberedBindings.length - restored.length;
        if (restored.length > 0) {
          const tracks = restored.reduce((sum, entry) => sum + entry.trackIds.length, 0);
          await logJob(
            root,
            job.id,
            `re-identified ${restored.length} athlete(s) across ${tracks} new track(s)`,
          );
        }
        if (lost > 0) {
          warnings.push(
            `${lost} athlete(s) could not be matched to the new tracks. Open "Identify your athlete" and pick them again.`,
          );
        }

        /**
         * Then widen that back out by appearance, because re-binding alone
         * cannot.
         *
         * `rebindAthletes` matches on overlap in space and time, so it can only
         * ever hand back the ground the athlete already held — it is incapable
         * of recovering the rest of the game. Identifying an athlete does widen
         * the binding by appearance, but only at the moment of the click, and
         * every subsequent detection run wiped that work: production shows the
         * pattern exactly, an athlete expanded once and then reduced to "9
         * athlete(s) across 18 new track(s)" — two fragments each — by the next
         * run, taking the moments down with it.
         *
         * Best-effort, and last: no worker, no proxy or no match must cost the
         * re-binding above, which is the part scoring genuinely cannot do
         * without.
         */
        await stage('re-identifying', 0.82);
        // Imported here rather than at the top because appearance.js imports
        // resolveCvWorker from this module, and a static cycle between the two
        // is a worse thing to own than one dynamic import.
        const { proposeAthleteTracks } = await import('./appearance.js');
        const { assignTracksToAthlete } = await import('./tracks.js');
        let widened = 0;
        for (const entry of restored) {
          try {
            const found = await proposeAthleteTracks(root, entry.athleteId, {
              ...(options.signal === undefined ? {} : { signal: options.signal }),
            });
            const added = found.proposals.map((proposal) => proposal.trackId);
            if (added.length === 0) continue;
            await assignTracksToAthlete(root, entry.athleteId, [
              ...new Set([...entry.trackIds, ...added]),
            ]);
            widened += added.length;
          } catch {
            // Survivable, per above. The re-bind stands.
          }
        }
        if (widened > 0) {
          await logJob(root, job.id, `followed them through ${widened} more track(s) by appearance`);
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
     * The failure that looks like success.
     *
     * Every warning below is gated on `momentsGenerated === 0`, which is the
     * shape of failure this job knew about. An athlete who has been named but
     * never pointed at produces the other shape: the scene signals still fire,
     * so the run returns a full set of moments about a busy gym, says "done" in
     * green, and the reel that comes out follows other people's children. It is
     * indistinguishable, from the outside, from tracking that lost the child —
     * which is exactly how it was reported. Say it whatever the count.
     */
    if (scored.unboundAthlete !== null) {
      const message =
        `${scored.unboundAthlete.label} is set as your athlete, but no track is bound to them, ` +
        'so nothing in these suggestions followed them — they score the court, not your child. ' +
        'Open "Identify your athlete", point at them on the footage, and it re-scores in seconds ' +
        'without re-running detection.';
      warnings.push(message);
      await logJob(root, job.id, message, 'warn');
    }

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
      /**
       * Judge this on what the scorer had, not on what this run created.
       * `tracksCreated` is zero for a score-only re-run, so binding an athlete
       * to 8394 existing tracks reported "no tracks were produced, the detector
       * found nothing it recognised" — directly contradicted by the very next
       * line, which counted them.
       */
      const scoredTracks = scored.diagnoses.reduce(
        (sum, entry) => sum + Object.values(entry.diagnosis.tracksByClass).reduce((a, b) => a + b, 0),
        0,
      );
      await logJob(
        root,
        job.id,
        scoredTracks === 0
          ? 'No tracks were produced, so there was nothing to score. The detector found nothing it recognised in this footage.'
          : `Tracks were found but none scored above the ${plugin.moments.minScore} threshold for ${manifest.sport}.`,
        'warn',
      );
      /**
       * The advice this used to give — "try marking an athlete" — was a guess
       * dressed as a diagnosis, and when it was wrong the user had no way to
       * tell. Report what was actually measured instead, and in particular
       * whether the threshold was reachable at all: telling someone their
       * footage scored too low is misleading when no footage could have scored
       * high enough.
       */
      for (const { diagnosis } of scored.diagnoses) {
        const classes =
          Object.entries(diagnosis.tracksByClass)
            .sort((a, b) => b[1] - a[1])
            .map(([name, count]) => `${name} ${count}`)
            .join(', ') || 'none';
        await logJob(
          root,
          job.id,
          `what was seen: ${classes}; longest track ${diagnosis.longestTrackSeconds.toFixed(1)}s; ` +
            `athlete identified: ${
              diagnosis.focalBound
                ? `yes, on screen ${diagnosis.focalSeconds.toFixed(1)}s of ` +
                  `${diagnosis.durationSeconds.toFixed(0)}s across ` +
                  `${diagnosis.focalTrackCount} track(s)`
                : 'no'
            }`,
          'warn',
        );
        await logJob(
          root,
          job.id,
          `scoring: best window ${diagnosis.bestScore.toFixed(3)} at ${diagnosis.bestTs.toFixed(0)}s ` +
            `vs threshold ${diagnosis.threshold}; highest reachable ${diagnosis.ceiling.toFixed(3)}` +
            (diagnosis.unmeasurable.length === 0
              ? ''
              : ` (no data for: ${diagnosis.unmeasurable.join(', ')})`),
          'warn',
        );
        /**
         * The binding is thin: said whether or not the threshold was reachable
         * in principle.
         *
         * Reachability is computed over the whole footage, so a rim visible for
         * half a minute can hold the ceiling above the threshold while the
         * athlete every focal signal depends on is present for a fraction of a
         * second. Production hit exactly that — a binding to a ten-frame
         * fragment of a five-minute game — and every line here read plausibly:
         * tracks found, athlete identified, threshold reachable, footage too
         * dull. The one number that showed the problem was not among them.
         */
        const coverage =
          diagnosis.durationSeconds > 0 ? diagnosis.focalSeconds / diagnosis.durationSeconds : 0;
        if (diagnosis.focalBound && coverage < 0.05) {
          await logJob(
            root,
            job.id,
            `your athlete is only on screen for ${diagnosis.focalSeconds.toFixed(1)}s of ` +
              `${diagnosis.durationSeconds.toFixed(0)}s (${(coverage * 100).toFixed(1)}%), so every ` +
              'signal that follows them is dark for the rest of the game. That is almost certainly ' +
              'the reason, not the footage. Open "Identify your athlete" and pick them again — ' +
              'choose every fragment of them you can see, not just one.',
            'warn',
          );
        }
        if (!diagnosis.reachable) {
          // The important case, and the one the old message got wrong.
          const because = !diagnosis.focalBound
            ? 'No athlete is identified, so every signal that follows your athlete stayed dark. Open "Identify your athlete" and pick your kid — it re-scores in seconds without re-running detection.'
            : (diagnosis.tracksByClass['ball'] ?? 0) === 0
              ? 'An athlete is identified, but no ball was detected in this footage, and ball proximity carries most of the weight.'
              : 'Too few signals had data for any window to clear the threshold.';
          await logJob(
            root,
            job.id,
            `nothing could have scored above ${diagnosis.threshold} on this run. ${because}`,
            'warn',
          );
        }
      }
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
