import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

import { isReelEelError } from '@reeleel/core';
import type { ReelEelErrorCode } from '@reeleel/core';

/**
 * Core throws domain errors with stable codes; the HTTP layer's only job is to
 * choose a status. Anything unmapped is a 500 — a new error code should be a
 * loud bug, not a silently-wrong 400.
 */
const STATUS_BY_CODE: Partial<Record<ReelEelErrorCode, ContentfulStatusCode>> = {
  PROJECT_NOT_FOUND: 404,
  NOT_FOUND: 404,
  PROJECT_EXISTS: 409,
  CONFLICT: 409,
  INVALID_INPUT: 400,
  PROJECT_INVALID: 400,
  MEDIA_UNSUPPORTED: 415,
  SPORT_UNKNOWN: 400,
  SOURCE_MISSING: 410,
  MODEL_MISSING: 404,
  UNSUPPORTED_OPERATION: 405,
  FFMPEG_MISSING: 503,
  WORKER_MISSING: 503,
  BACKEND_UNAVAILABLE: 503,
  DISK_SPACE_LOW: 507,
};

export const errorResponse = (c: Context, error: unknown): Response => {
  if (isReelEelError(error)) {
    return c.json(
      { ok: false, code: error.code, error: error.message, hint: error.hint },
      STATUS_BY_CODE[error.code] ?? 500,
    );
  }
  return c.json(
    {
      ok: false,
      code: 'UNKNOWN',
      error: error instanceof Error ? error.message : String(error),
    },
    500,
  );
};

/** Wraps a handler so domain errors become well-formed JSON instead of a 500 page. */
export const handle =
  <T>(fn: (c: Context) => Promise<T>) =>
  async (c: Context): Promise<Response> => {
    try {
      const result = await fn(c);
      return c.json({ ok: true, ...(result as object) });
    } catch (error) {
      return errorResponse(c, error);
    }
  };
