import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';

import { ReelEelError } from './errors.js';
import { formatTimecode, requireBinary, run } from './ffmpeg.js';
import { projectDir } from './layout.js';
import type { SourceVideo } from './types.js';
import { updateVideo } from './videos.js';

export interface ThumbnailOptions {
  /** Evenly spaced frames across the video. */
  count?: number;
  height?: number;
  signal?: AbortSignal;
}

export interface ThumbnailResult {
  dir: string;
  files: string[];
}

/**
 * Scrub thumbnails. Generated from the source with `-skip_frame nokey` so a
 * full-length game does not need a full decode pass.
 */
export const generateThumbnails = async (
  root: string,
  video: SourceVideo,
  options: ThumbnailOptions = {},
): Promise<ThumbnailResult> => {
  const duration = video.probe?.durationSeconds ?? 0;
  if (duration <= 0) {
    throw new ReelEelError('MEDIA_CORRUPT', `${video.path} reports a zero duration.`);
  }
  if (!existsSync(video.path)) {
    throw new ReelEelError('SOURCE_MISSING', `${video.path} is gone.`, {
      hint: `Re-point it: reeleel import update ${video.id} --path <new location>`,
    });
  }

  const ffmpeg = requireBinary('ffmpeg');
  const count = options.count ?? 60;
  const height = options.height ?? 180;
  const dir = path.join(projectDir(root, 'thumbnails'), video.id);

  // Regenerating replaces the set rather than mixing old and new frames.
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  const fps = count / duration;
  const result = await run(
    ffmpeg,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      video.path,
      '-vf',
      `fps=${fps.toFixed(6)},scale=-2:${height}`,
      '-frames:v',
      String(count),
      '-q:v',
      '4',
      path.join(dir, 'thumb_%05d.jpg'),
    ],
    options.signal === undefined ? {} : { signal: options.signal },
  );

  if (result.code !== 0) {
    throw new ReelEelError('MEDIA_CORRUPT', `Thumbnail generation failed for ${video.path}.`, {
      hint: result.stderr.trim().split('\n').at(-1) ?? undefined,
    });
  }

  await updateVideo(root, video.id, { thumbnailDir: dir });
  return { dir, files: readdirSync(dir).sort() };
};

/**
 * Proxy height in pixels. 540 keeps scrubbing smooth on a laptop.
 *
 * Exported because analysis has to be able to ask whether the proxy is big
 * enough to detect from, rather than assuming it always is.
 */
export const PROXY_HEIGHT = 540;

export interface ProxyOptions {
  /** Proxy height in pixels. Defaults to {@link PROXY_HEIGHT}. */
  height?: number;
  crf?: number;
  signal?: AbortSignal;
  onProgress?: (line: string) => void;
}

/**
 * A low-resolution editing proxy. The original is never modified and is always
 * what the final render reads from — the proxy exists purely so scrubbing and
 * CPU-only analysis stay responsive.
 */
export const generateProxy = async (
  root: string,
  video: SourceVideo,
  options: ProxyOptions = {},
): Promise<string> => {
  if (!existsSync(video.path)) {
    throw new ReelEelError('SOURCE_MISSING', `${video.path} is gone.`);
  }

  const ffmpeg = requireBinary('ffmpeg');
  const height = options.height ?? PROXY_HEIGHT;
  const dir = projectDir(root, 'proxies');
  mkdirSync(dir, { recursive: true });
  const output = path.join(dir, `${video.id}_${height}p.mp4`);

  const result = await run(
    ffmpeg,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-i',
      video.path,
      '-vf',
      `scale=-2:${height}`,
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      String(options.crf ?? 26),
      // Frequent keyframes keep seeking snappy during review.
      '-g',
      '48',
      '-c:a',
      'aac',
      '-b:a',
      '128k',
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
    throw new ReelEelError('MEDIA_CORRUPT', `Proxy generation failed for ${video.path}.`, {
      hint: result.stderr.trim().split('\n').at(-1) ?? undefined,
    });
  }

  await updateVideo(root, video.id, { proxyPath: output });
  return output;
};

/** Single poster frame, used for project list previews. */
export const extractFrame = async (
  videoPath: string,
  ts: number,
  outputPath: string,
  height = 720,
): Promise<string> => {
  const ffmpeg = requireBinary('ffmpeg');
  mkdirSync(path.dirname(outputPath), { recursive: true });
  const result = await run(ffmpeg, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    // -ss before -i seeks by keyframe, which is fast and accurate enough here.
    '-ss',
    formatTimecode(ts),
    '-i',
    videoPath,
    '-frames:v',
    '1',
    '-vf',
    `scale=-2:${height}`,
    outputPath,
  ]);
  if (result.code !== 0) {
    throw new ReelEelError('MEDIA_CORRUPT', `Could not extract a frame at ${ts}s.`);
  }
  return outputPath;
};
