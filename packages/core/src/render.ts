import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { OUTPUT_DIMENSIONS, computeCropPath, toCropExpression } from './camera.js';
import { getFocalAthlete } from './athletes.js';
import { all, execute, projectDb } from './db.js';
import { ReelEelError } from './errors.js';
import { formatTimecode, requireBinary, run } from './ffmpeg.js';
import { newId, nowIso, slugify } from './ids.js';
import { projectDir } from './layout.js';
import { getClip, listClips, updateClip } from './clips.js';
import { readManifest } from './projects.js';
import { getReel } from './reels.js';
import { loadTrackSeries } from './tracks.js';
import type { AspectRatio, Clip, Reel } from './types.js';
import { getVideo, listVideos } from './videos.js';

/**
 * How loud the music bed sits under the game.
 *
 * The crowd, the shoes and a parent shouting are most of why a clip is worth
 * keeping; music that competes with them makes the reel worse, not better.
 */
export const DEFAULT_MUSIC_VOLUME = 0.18;

const CRF_FOR_QUALITY: Record<'low' | 'medium' | 'high', number> = {
  low: 28,
  medium: 23,
  high: 19,
};

export interface RenderClipOptions {
  aspect?: AspectRatio;
  fps?: number;
  quality?: 'low' | 'medium' | 'high';
  /** Skip the Virtual Cameraman and keep the full frame. */
  noCrop?: boolean;
  /** Seconds of fade at each end. 0 turns it off. */
  fadeSeconds?: number;
  signal?: AbortSignal;
  onProgress?: (line: string) => void;
}

/** Default fade, short enough to feel like an edit rather than a transition. */
export const DEFAULT_FADE_SECONDS = 0.35;

/**
 * Fade filters for a clip of a known length.
 *
 * Cutting straight between plays is jarring, and the audio cut is worse than
 * the picture: a crowd at full volume stopping dead mid-syllable reads as a
 * glitch. Both are faded, and the fade is clamped to a third of the clip so a
 * short moment does not become entirely fade.
 *
 * Returned as separate video and audio chains because they attach to different
 * FFmpeg flags, and as empty strings when there is nothing to do — an empty
 * `-af` is an error, not a no-op.
 */
export const fadeFilters = (
  durationSeconds: number,
  fadeSeconds = DEFAULT_FADE_SECONDS,
): { video: string; audio: string } => {
  const fade = Math.min(fadeSeconds, durationSeconds / 3);
  if (!Number.isFinite(fade) || fade <= 0 || !Number.isFinite(durationSeconds)) {
    return { video: '', audio: '' };
  }
  const out = Math.max(0, durationSeconds - fade).toFixed(3);
  const d = fade.toFixed(3);
  return {
    video: `fade=t=in:st=0:d=${d},fade=t=out:st=${out}:d=${d}`,
    audio: `afade=t=in:st=0:d=${d},afade=t=out:st=${out}:d=${d}`,
  };
};

/**
 * Builds the video filter chain for one clip. Split out so tests can assert the
 * crop expression without shelling out to FFmpeg.
 */
export const buildClipFilter = async (
  root: string,
  clip: Clip,
  aspect: AspectRatio,
  options: { noCrop?: boolean } = {},
): Promise<string> => {
  const output = OUTPUT_DIMENSIONS[aspect];
  const scaleAndPad = [
    `scale=${output.width}:${output.height}:force_original_aspect_ratio=decrease`,
    `pad=${output.width}:${output.height}:(ow-iw)/2:(oh-ih)/2:black`,
    'setsar=1',
  ].join(',');

  if (options.noCrop === true || clip.cameraMode === 'wide' || clip.videoId === null) {
    return scaleAndPad;
  }

  const video = (await listVideos(root)).find((candidate) => candidate.id === clip.videoId);
  const width = video?.probe?.video?.width ?? 0;
  const height = video?.probe?.video?.height ?? 0;
  if (width <= 0 || height <= 0) return scaleAndPad;

  const tracks = await loadTrackSeries(root, clip.videoId);
  if (tracks.length === 0) {
    // No tracks means no camera path to follow — fall back to the full frame
    // rather than inventing a crop.
    return scaleAndPad;
  }

  const focalAthlete = await getFocalAthlete(root);
  const focal =
    tracks.find((track) => track.id === focalAthlete?.focalTrackId) ??
    tracks.find((track) => track.className === 'player') ??
    null;
  const ball = tracks.find((track) => track.className === 'ball') ?? null;

  const cropPath = computeCropPath({
    mode: clip.cameraMode,
    aspect,
    sourceWidth: width,
    sourceHeight: height,
    startTs: clip.start,
    endTs: clip.end,
    focal,
    ball,
    others: tracks.filter((track) => track.className === 'player'),
  });
  if (cropPath.length === 0) return scaleAndPad;

  const first = cropPath[0];
  if (first === undefined) return scaleAndPad;

  // `t` inside the filter is relative to the trimmed clip, so rebase the path.
  const rebased = cropPath.map((keyframe) => ({ ...keyframe, ts: keyframe.ts - clip.start }));
  const cropExpr = [
    `crop=${first.width}:${first.height}`,
    `x='${toCropExpression(rebased, 'x')}'`,
    `y='${toCropExpression(rebased, 'y')}'`,
  ].join(':');

  return `${cropExpr},${scaleAndPad}`;
};

export const renderClip = async (
  root: string,
  reference: string,
  options: RenderClipOptions = {},
): Promise<string> => {
  const clip = await getClip(root, reference);
  if (clip.videoId === null) {
    throw new ReelEelError('INVALID_INPUT', `Clip ${clip.id} is not attached to a video.`);
  }

  const video = await getVideo(root, clip.videoId);
  if (!existsSync(video.path)) {
    throw new ReelEelError('SOURCE_MISSING', `${video.path} is gone.`, {
      hint: `Re-point it: reeleel import update ${video.id} --path <new location>`,
    });
  }

  const ffmpeg = requireBinary('ffmpeg');
  const aspect = options.aspect ?? '16:9';
  const dir = projectDir(root, 'clips');
  mkdirSync(dir, { recursive: true });
  const output = path.join(dir, `${clip.id}_${aspect.replace(':', 'x')}.mp4`);

  /**
   * Faded at both ends, picture and sound. Straight cuts between plays are
   * jarring and the audio cut is the worse of the two — a crowd stopping dead
   * mid-syllable reads as a broken file rather than an edit.
   */
  const fades = fadeFilters(clip.end - clip.start, options.fadeSeconds);
  const cropFilter = await buildClipFilter(
    root,
    clip,
    aspect,
    options.noCrop === undefined ? {} : { noCrop: options.noCrop },
  );
  const videoFilter = fades.video === '' ? cropFilter : `${cropFilter},${fades.video}`;

  const result = await run(
    ffmpeg,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      // Accurate seek: -ss after -i costs a decode but lands on the right frame.
      '-i',
      video.path,
      '-ss',
      formatTimecode(clip.start),
      '-to',
      formatTimecode(clip.end),
      '-vf',
      videoFilter,
      ...(fades.audio === '' ? [] : ['-af', fades.audio]),
      '-r',
      String(options.fps ?? 30),
      '-c:v',
      'libx264',
      '-preset',
      'medium',
      '-crf',
      String(CRF_FOR_QUALITY[options.quality ?? 'high']),
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-b:a',
      '160k',
      '-movflags',
      '+faststart',
      output,
    ],
    {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.onProgress === undefined ? {} : { onStderr: options.onProgress }),
    },
  );

  if (result.code !== 0) {
    throw new ReelEelError('RENDER_INTERRUPTED', `Rendering clip ${clip.id} failed.`, {
      hint: result.stderr.trim().split('\n').at(-1) ?? undefined,
    });
  }

  await updateClip(root, clip.id, { renderedPath: output });
  return output;
};

export interface RenderReelOptions {
  aspect?: AspectRatio;
  fps?: number;
  quality?: 'low' | 'medium' | 'high';
  output?: string;
  /** Burn the athlete's name/number into the corner. */
  label?: string;
  watermark?: boolean;
  /** Audio file to lay under the reel. Looped and trimmed to the footage. */
  musicPath?: string;
  /** 0..1, well under the game audio so the crowd still carries the clip. */
  musicVolume?: number;
  /** Seconds of fade on each clip. 0 turns it off. */
  fadeSeconds?: number;
  signal?: AbortSignal;
  onProgress?: (stage: string) => void;
}

export interface RenderReelResult {
  reel: Reel;
  outputPath: string;
  clipCount: number;
  durationSeconds: number;
}

export const renderReel = async (
  root: string,
  reference: string,
  options: RenderReelOptions = {},
): Promise<RenderReelResult> => {
  const reel = await getReel(root, reference);
  const aspect = options.aspect ?? reel.aspect;
  const manifest = readManifest(root);

  const byId = new Map((await listClips(root)).map((clip) => [clip.id, clip]));
  const clips = reel.clipIds
    .map((id) => byId.get(id))
    .filter((clip): clip is Clip => clip !== undefined);

  if (clips.length === 0) {
    throw new ReelEelError('INVALID_INPUT', `Reel "${reel.name}" has no clips.`, {
      hint: 'Accept some suggested moments first: `reeleel moments update <n> --include`.',
    });
  }

  const ffmpeg = requireBinary('ffmpeg');
  const exportsDir = projectDir(root, 'exports');
  mkdirSync(exportsDir, { recursive: true });
  const outputPath =
    options.output === undefined
      ? nextExportPath(exportsDir, `${slugify(reel.name)}_${aspect.replace(':', 'x')}`)
      : path.resolve(options.output);

  // Render each clip to a uniform intermediate so concat is stream-safe.
  const stagingDir = path.join(exportsDir, `.staging_${reel.id}`);
  rmSync(stagingDir, { recursive: true, force: true });
  mkdirSync(stagingDir, { recursive: true });

  const rendered: string[] = [];
  try {
    for (const [index, clip] of clips.entries()) {
      options.onProgress?.(`Rendering clip ${index + 1}/${clips.length}`);
      const clipOptions: RenderClipOptions = { aspect };
      if (options.fadeSeconds !== undefined) clipOptions.fadeSeconds = options.fadeSeconds;
      if (options.fps !== undefined) clipOptions.fps = options.fps;
      if (options.quality !== undefined) clipOptions.quality = options.quality;
      if (options.signal !== undefined) clipOptions.signal = options.signal;
      rendered.push(await renderClip(root, clip.id, clipOptions));
    }

    const listFile = path.join(stagingDir, 'concat.txt');
    writeFileSync(
      listFile,
      // Single quotes are escaped the way the concat demuxer expects.
      `${rendered.map((file) => `file '${file.replaceAll("'", "'\\''")}'`).join('\n')}\n`,
      'utf8',
    );

    options.onProgress?.('Assembling reel');
    const filters: string[] = [];
    if (options.label !== undefined && options.label.length > 0) {
      const escaped = options.label.replaceAll(':', '\\:').replaceAll("'", "\\'");
      filters.push(
        `drawtext=text='${escaped}':fontcolor=white:fontsize=h/24:box=1:boxcolor=black@0.45:boxborderw=12:x=w/32:y=h-th-h/32`,
      );
    }
    if (options.watermark === true) {
      filters.push(
        `drawtext=text='ReelEel':fontcolor=white@0.7:fontsize=h/40:x=w-tw-w/40:y=h-th-h/40`,
      );
    }

    const args = ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', listFile];

    /**
     * Music under the game audio, not instead of it.
     *
     * The crowd, the squeak of shoes and a parent shouting are most of why the
     * clip is worth keeping, so the bed sits well below them and the game stays
     * at full level. It is looped because a reel is usually longer than
     * whatever was uploaded, trimmed to the reel with `duration=first`, and
     * faded at the end so it stops rather than being cut off mid-bar.
     */
    const music = options.musicPath;
    const hasMusic = music !== undefined && music.length > 0;
    if (hasMusic) {
      if (!existsSync(music)) {
        throw new ReelEelError('SOURCE_MISSING', `Background music ${music} is gone.`, {
          hint: 'Upload it again, or render without music.',
        });
      }
      args.push('-stream_loop', '-1', '-i', music);
    }

    const totalSeconds = clips.reduce((sum, clip) => sum + (clip.end - clip.start), 0);
    const musicFade = Math.min(2, totalSeconds / 4);
    const volume = options.musicVolume ?? DEFAULT_MUSIC_VOLUME;

    if (hasMusic) {
      const chain = [
        `[1:a]volume=${volume.toFixed(3)}`,
        `afade=t=out:st=${Math.max(0, totalSeconds - musicFade).toFixed(3)}:d=${musicFade.toFixed(3)}[bed]`,
      ].join(',');
      // `duration=first` ends the mix with the footage; the looped bed would
      // otherwise run for ever.
      const complex =
        filters.length > 0
          ? `[0:v]${filters.join(',')}[v];${chain};[0:a][bed]amix=inputs=2:duration=first:dropout_transition=0[a]`
          : `${chain};[0:a][bed]amix=inputs=2:duration=first:dropout_transition=0[a]`;
      args.push('-filter_complex', complex);
      args.push('-map', filters.length > 0 ? '[v]' : '0:v', '-map', '[a]');
      args.push('-c:v', filters.length > 0 ? 'libx264' : 'copy');
      if (filters.length > 0) args.push('-crf', String(CRF_FOR_QUALITY[options.quality ?? 'high']));
      args.push('-c:a', 'aac', '-b:a', '192k');
    } else if (filters.length > 0) {
      args.push('-vf', filters.join(','), '-c:v', 'libx264', '-crf', String(CRF_FOR_QUALITY[options.quality ?? 'high']), '-c:a', 'aac');
    } else {
      // No overlay and no music means no re-encode — fast and lossless.
      args.push('-c', 'copy');
    }
    args.push('-movflags', '+faststart', outputPath);

    const result = await run(ffmpeg, args, options.signal === undefined ? {} : { signal: options.signal });
    if (result.code !== 0) {
      throw new ReelEelError('RENDER_INTERRUPTED', `Assembling reel "${reel.name}" failed.`, {
        hint: result.stderr.trim().split('\n').at(-1) ?? undefined,
      });
    }
  } finally {
    rmSync(stagingDir, { recursive: true, force: true });
  }

  const db = await projectDb(root);
  await execute(
    db,
    'INSERT INTO exports (id, project_id, reel_id, path, aspect, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [newId('exp'), manifest.id, reel.id, outputPath, aspect, nowIso()],
  );

  return {
    reel,
    outputPath,
    clipCount: clips.length,
    durationSeconds: clips.reduce((total, clip) => total + (clip.end - clip.start), 0),
  };
};

/**
 * The next free `<stem>.mp4`, `<stem>-2.mp4`, `<stem>-3.mp4`…
 *
 * Exports used to be written to a path derived from the reel name alone, so
 * every re-export silently replaced the previous file. A render is minutes of
 * work and the old one may already have been shared; destroying it to make room
 * for the new one is not a reasonable default. Keeping both leaves the choice
 * with the person who made them.
 */
export const nextExportPath = (dir: string, stem: string): string => {
  const first = path.join(dir, `${stem}.mp4`);
  if (!existsSync(first)) return first;
  for (let n = 2; n < 10_000; n += 1) {
    const candidate = path.join(dir, `${stem}-${n}.mp4`);
    if (!existsSync(candidate)) return candidate;
  }
  return path.join(dir, `${stem}-${Date.now()}.mp4`);
};

export interface ExportRecord {
  id: string;
  reelId: string | null;
  path: string;
  aspect: AspectRatio;
  createdAt: string;
}

export const listExports = async (root: string): Promise<ExportRecord[]> => {
  const db = await projectDb(root);
  const rows = await all<{
    id: string;
    reel_id: string | null;
    path: string;
    aspect: AspectRatio;
    created_at: string;
  }>(db, 'SELECT id, reel_id, path, aspect, created_at FROM exports ORDER BY created_at DESC');

  return rows.map((row) => ({
    id: row.id,
    reelId: row.reel_id,
    path: row.path,
    aspect: row.aspect,
    createdAt: row.created_at,
  }));
};

export const removeExport = async (
  root: string,
  exportId: string,
  deleteFile = false,
): Promise<ExportRecord> => {
  const record = (await listExports(root)).find((entry) => entry.id === exportId);
  if (record === undefined) {
    throw new ReelEelError('NOT_FOUND', `Export "${exportId}" not found.`);
  }
  const db = await projectDb(root);
  await execute(db, 'DELETE FROM exports WHERE id = ?', [exportId]);
  if (deleteFile && existsSync(record.path)) rmSync(record.path, { force: true });
  return record;
};
