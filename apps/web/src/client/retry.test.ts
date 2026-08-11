import { describe, expect, it } from 'vitest';

import {
  CHUNK_RETRY_BUDGET_MS,
  IMPORT_RETRY_BUDGET_MS,
  backoffMs,
  isLostAnswer,
  isRetryable,
} from './retry.js';

/**
 * The bug these exist for: a 2 GB import died at 6% with "the server returned
 * 502". Nothing was wrong with the file, the limits, or the bytes already
 * stored — the platform edge hung up on one chunk, and the uploader treated a
 * single dropped chunk as the end of the transfer.
 *
 * So what matters here is the line between "try again" and "stop", and getting
 * it wrong is expensive in both directions: retrying a rejected file spams the
 * server with an upload that can never succeed, and not retrying a dropped
 * connection is the original bug.
 */

describe('deciding whether a dropped chunk is worth resending', () => {
  it('retries the edge failure that killed the original upload', () => {
    // The 502 never reaches the app, so it arrives with no code of ours.
    expect(isRetryable('HTTP_502', 502)).toBe(true);
  });

  it('retries a connection that produced no response at all', () => {
    expect(isRetryable('NETWORK', 0)).toBe(true);
  });

  it('waits out a chunk the server is still writing', () => {
    // The abandoned write drains for a while after the client is gone; two
    // writers on one part file would corrupt it, so waiting is the only answer.
    expect(isRetryable('UPLOAD_BUSY', 409)).toBe(true);
  });

  it('retries an offset mismatch, which resyncing resolves', () => {
    expect(isRetryable('UPLOAD_OFFSET_MISMATCH', 409)).toBe(true);
  });

  it.each([502, 503, 504, 500, 408, 429])('retries %i', (status) => {
    expect(isRetryable(`HTTP_${status}`, status)).toBe(true);
  });

  it('does not retry a file the server will never accept', () => {
    expect(isRetryable('UPLOAD_TOO_LARGE', 413)).toBe(false);
    expect(isRetryable('MEDIA_UNSUPPORTED', 415)).toBe(false);
    expect(isRetryable('CONFLICT', 409)).toBe(false);
    expect(isRetryable('DISK_SPACE_LOW', 507)).toBe(false);
  });

  it('treats a user pressing Pause or Cancel as an instruction, not a fault', () => {
    expect(isRetryable('ABORTED', 0)).toBe(false);
  });
});

/**
 * Finishing an upload is safe to repeat only because a lost answer means the
 * import never really ran. Repeating one that ran and failed is not a retry —
 * it is the same failure again, and on a multi-gigabyte file it is expensive.
 */
describe('deciding whether an import is worth asking about again', () => {
  it('asks again when the edge answered instead of the app', () => {
    expect(isLostAnswer('HTTP_502', 502)).toBe(true);
    expect(isLostAnswer('HTTP_504', 504)).toBe(true);
  });

  it('asks again when the connection produced no answer at all', () => {
    expect(isLostAnswer('NETWORK', 0)).toBe(true);
  });

  it('does not repeat an import that ran and failed', () => {
    // A 500 carries the reason the file could not be read; retrying re-reads it.
    expect(isLostAnswer('MEDIA_UNREADABLE', 500)).toBe(false);
    expect(isLostAnswer('UPLOAD_INCOMPLETE', 409)).toBe(false);
  });

  it('is stricter than the rule chunks use', () => {
    // 500 is worth resending a chunk to and not worth re-importing on.
    expect(isRetryable('HTTP_500', 500)).toBe(true);
    expect(isLostAnswer('HTTP_500', 500)).toBe(false);
  });

  it('waits longer than a chunk does, because the work is bigger', () => {
    expect(IMPORT_RETRY_BUDGET_MS).toBeGreaterThan(CHUNK_RETRY_BUDGET_MS);
  });
});

describe('how long to wait between attempts', () => {
  it('backs off', () => {
    expect(backoffMs(1)).toBeLessThan(backoffMs(2));
    expect(backoffMs(2)).toBeLessThan(backoffMs(3));
  });

  it('starts quickly enough not to stall a healthy upload', () => {
    expect(backoffMs(1)).toBeLessThanOrEqual(1000);
  });

  it('plateaus, so a long import never sits idle for minutes', () => {
    expect(backoffMs(50)).toBeLessThanOrEqual(10_000);
    expect(backoffMs(1000)).toBeLessThanOrEqual(10_000);
  });

  it('gives a stuck chunk longer than the server takes to release a stalled write', () => {
    // receive.ts gives up on a silent connection after 120s; quitting sooner
    // would abandon uploads that were about to recover on their own.
    expect(CHUNK_RETRY_BUDGET_MS).toBeGreaterThan(120_000);
  });
});
