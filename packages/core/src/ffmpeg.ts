import { spawn } from 'node:child_process';
import { accessSync, constants, existsSync, statSync } from 'node:fs';
import path from 'node:path';

import { ReelEelError } from './errors.js';
import type { AudioStreamInfo, ProbeResult, VideoStreamInfo } from './types.js';

export type FfBinary = 'ffmpeg' | 'ffprobe';

const WINDOWS = process.platform === 'win32';

/** Places a user-installed FFmpeg commonly lands when it isn't on PATH. */
const EXTRA_DIRS: Record<string, string[]> = {
  darwin: ['/opt/homebrew/bin', '/usr/local/bin', '/opt/local/bin'],
  linux: ['/usr/bin', '/usr/local/bin', '/snap/bin', '/var/lib/flatpak/exports/bin'],
  win32: ['C:\\ffmpeg\\bin', 'C:\\Program Files\\ffmpeg\\bin'],
};

const isExecutable = (candidate: string): boolean => {
  try {
    if (!existsSync(candidate) || !statSync(candidate).isFile()) return false;
    if (WINDOWS) return true;
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

const withExeSuffix = (name: string): string[] => (WINDOWS ? [`${name}.exe`, name] : [name]);

/**
 * Resolution order: explicit env override, then PATH, then the usual install
 * directories. Returns null rather than throwing so `doctor` can report on both
 * binaries in one pass.
 */
export const findBinary = (binary: FfBinary): string | null => {
  const override = process.env[binary === 'ffmpeg' ? 'REELEEL_FFMPEG' : 'REELEEL_FFPROBE'];
  if (override !== undefined && override.length > 0) {
    return isExecutable(override) ? override : null;
  }

  const pathDirs = (process.env['PATH'] ?? '').split(path.delimiter).filter((d) => d.length > 0);
  const extra = EXTRA_DIRS[process.platform] ?? [];
  for (const dir of [...pathDirs, ...extra]) {
    for (const name of withExeSuffix(binary)) {
      const candidate = path.join(dir, name);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return null;
};

const INSTALL_HINT: Record<NodeJS.Platform | 'default', string> = {
  darwin: 'Install it with `brew install ffmpeg`.',
  linux: 'Install it with `sudo apt install ffmpeg` (or your distro equivalent).',
  win32: 'Install it with `winget install Gyan.FFmpeg`.',
  default: 'Install FFmpeg from https://ffmpeg.org/download.html.',
} as Record<NodeJS.Platform | 'default', string>;

export const requireBinary = (binary: FfBinary): string => {
  const found = findBinary(binary);
  if (found !== null) return found;
  const platformHint = INSTALL_HINT[process.platform] ?? INSTALL_HINT.default;
  throw new ReelEelError('FFMPEG_MISSING', `${binary} was not found on this system.`, {
    hint: `${platformHint} Or point ReelEel at it: reeleel config set ffmpeg.${binary} /path/to/${binary}`,
  });
};

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export const run = (
  binary: string,
  args: readonly string[],
  options: { signal?: AbortSignal; onStderr?: (chunk: string) => void } = {},
): Promise<RunResult> =>
  new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';

    const abort = (): void => {
      child.kill('SIGTERM');
    };
    options.signal?.addEventListener('abort', abort, { once: true });

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      options.onStderr?.(text);
    });
    child.on('error', (error) => {
      options.signal?.removeEventListener('abort', abort);
      reject(error);
    });
    child.on('close', (code) => {
      options.signal?.removeEventListener('abort', abort);
      if (options.signal?.aborted === true) {
        reject(new ReelEelError('JOB_CANCELED', 'Canceled.'));
        return;
      }
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  channels?: number;
  sample_rate?: string;
  side_data_list?: { rotation?: number }[];
  tags?: { rotate?: string };
}

interface FfprobeOutput {
  format?: {
    format_name?: string;
    duration?: string;
    size?: string;
    bit_rate?: string;
  };
  streams?: FfprobeStream[];
}

/** ffprobe reports frame rate as a rational string like "30000/1001". */
export const parseFrameRate = (value: string | undefined): number => {
  if (value === undefined) return 0;
  const [numerator, denominator] = value.split('/');
  const n = Number(numerator);
  const d = denominator === undefined ? 1 : Number(denominator);
  if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0) return 0;
  return n / d;
};

const parseRotation = (stream: FfprobeStream): number => {
  const fromSideData = stream.side_data_list?.find((s) => s.rotation !== undefined)?.rotation;
  if (fromSideData !== undefined) return ((Math.round(fromSideData) % 360) + 360) % 360;
  const fromTag = stream.tags?.rotate;
  if (fromTag !== undefined) {
    const parsed = Number(fromTag);
    if (Number.isFinite(parsed)) return ((Math.round(parsed) % 360) + 360) % 360;
  }
  return 0;
};

/** Turns raw ffprobe JSON into our ProbeResult. Exported for unit testing. */
export const parseProbeOutput = (file: string, json: string): ProbeResult => {
  let parsed: FfprobeOutput;
  try {
    parsed = JSON.parse(json) as FfprobeOutput;
  } catch (cause) {
    throw new ReelEelError('FFPROBE_FAILED', `Could not parse ffprobe output for ${file}.`, {
      cause,
    });
  }

  const streams = parsed.streams ?? [];
  const videoStream = streams.find((s) => s.codec_type === 'video');
  const audioStream = streams.find((s) => s.codec_type === 'audio');

  if (parsed.format === undefined || (videoStream === undefined && audioStream === undefined)) {
    throw new ReelEelError('MEDIA_UNSUPPORTED', `${file} has no readable audio or video streams.`, {
      hint: 'The file may be corrupt or in a container FFmpeg was not built to read.',
    });
  }

  const video: VideoStreamInfo | undefined =
    videoStream === undefined
      ? undefined
      : {
          codec: videoStream.codec_name ?? 'unknown',
          width: videoStream.width ?? 0,
          height: videoStream.height ?? 0,
          fps: parseFrameRate(videoStream.avg_frame_rate ?? videoStream.r_frame_rate),
          rotation: parseRotation(videoStream),
        };

  const audio: AudioStreamInfo | undefined =
    audioStream === undefined
      ? undefined
      : {
          codec: audioStream.codec_name ?? 'unknown',
          channels: audioStream.channels ?? 0,
          sampleRate: Number(audioStream.sample_rate ?? 0),
        };

  const result: ProbeResult = {
    path: file,
    container: parsed.format.format_name ?? 'unknown',
    durationSeconds: Number(parsed.format.duration ?? 0),
    sizeBytes: Number(parsed.format.size ?? 0),
    bitRate: Number(parsed.format.bit_rate ?? 0),
  };
  if (video !== undefined) result.video = video;
  if (audio !== undefined) result.audio = audio;
  return result;
};

export const probe = async (file: string, signal?: AbortSignal): Promise<ProbeResult> => {
  const absolute = path.resolve(file);
  if (!existsSync(absolute)) {
    throw new ReelEelError('SOURCE_MISSING', `${absolute} does not exist.`);
  }

  const ffprobe = requireBinary('ffprobe');
  const result = await run(
    ffprobe,
    [
      '-v',
      'error',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      '-show_entries',
      'stream=codec_type,codec_name,width,height,avg_frame_rate,r_frame_rate,channels,sample_rate:stream_side_data=rotation:stream_tags=rotate:format=format_name,duration,size,bit_rate',
      absolute,
    ],
    signal === undefined ? {} : { signal },
  );

  if (result.code !== 0) {
    throw new ReelEelError('FFPROBE_FAILED', `ffprobe could not read ${absolute}.`, {
      hint: result.stderr.trim().split('\n').at(-1) ?? 'The file may be corrupt or unsupported.',
      details: { exitCode: result.code },
    });
  }

  return parseProbeOutput(absolute, result.stdout);
};

/** `hh:mm:ss.mmm` for humans and for FFmpeg `-ss`/`-to`. */
export const formatTimecode = (seconds: number): string => {
  const safe = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const secs = safe % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${secs
    .toFixed(3)
    .padStart(6, '0')}`;
};

/** Accepts `12`, `1:23`, `1:02:03`, `90.5` — the CLI takes any of them. */
export const parseTimecode = (value: string): number => {
  const trimmed = value.trim();
  if (trimmed.length === 0) return Number.NaN;
  const parts = trimmed.split(':').map((p) => Number(p));
  if (parts.some((p) => !Number.isFinite(p))) return Number.NaN;
  return parts.reduce((total, part) => total * 60 + part, 0);
};
