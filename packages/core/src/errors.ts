/**
 * Every failure the PRD asks us to handle gracefully gets a stable code so the
 * CLI can print an actionable hint and the GUI can key off it without parsing
 * message strings.
 */
export type ReelEelErrorCode =
  | 'FFMPEG_MISSING'
  | 'FFPROBE_FAILED'
  | 'MEDIA_UNSUPPORTED'
  | 'MEDIA_CORRUPT'
  | 'SOURCE_MISSING'
  | 'DISK_SPACE_LOW'
  | 'PROJECT_NOT_FOUND'
  | 'PROJECT_EXISTS'
  | 'PROJECT_INVALID'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'INVALID_INPUT'
  | 'SPORT_UNKNOWN'
  | 'MODEL_MISSING'
  | 'MODEL_CORRUPT'
  | 'WORKER_MISSING'
  | 'WORKER_CRASHED'
  | 'BACKEND_UNAVAILABLE'
  | 'OUT_OF_MEMORY'
  | 'JOB_CANCELED'
  | 'RENDER_INTERRUPTED'
  | 'UNSUPPORTED_OPERATION';

export interface ReelEelErrorOptions {
  /** One-line, user-facing "here's what to do about it". */
  hint?: string;
  cause?: unknown;
  details?: Record<string, unknown>;
}

export class ReelEelError extends Error {
  readonly code: ReelEelErrorCode;
  readonly hint?: string;
  readonly details?: Record<string, unknown>;

  constructor(code: ReelEelErrorCode, message: string, options: ReelEelErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ReelEelError';
    this.code = code;
    this.hint = options.hint;
    this.details = options.details;
  }
}

export const isReelEelError = (value: unknown): value is ReelEelError =>
  value instanceof ReelEelError;

export const notFound = (what: string, id: string): ReelEelError =>
  new ReelEelError('NOT_FOUND', `${what} "${id}" not found.`);

export const invalidInput = (message: string, hint?: string): ReelEelError =>
  new ReelEelError('INVALID_INPUT', message, hint === undefined ? {} : { hint });
