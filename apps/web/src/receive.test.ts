import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { UploadError, receiveVideoUpload, safeFileName } from './receive.js';
import { beginUpload, resetUploads } from './uploads.js';
import type { ReceiveResult } from './receive.js';
import type { UploadRecord } from './uploads.js';

const BOUNDARY = '----ReelEelTest';

let root: string;

beforeEach(async () => {
  resetUploads();
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  root = await mkdtemp(path.join(tmpdir(), 'reeleel-upload-'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  delete process.env['REELEEL_UPLOAD_STALL_SECONDS'];
  delete process.env['REELEEL_MAX_UPLOAD_BYTES'];
  await rm(root, { recursive: true, force: true });
});

interface Attempt {
  result?: ReceiveResult;
  error?: unknown;
  record: UploadRecord;
}

/**
 * Posts a multipart body through a real Hono context, so the code under test
 * sees exactly the Request it sees in production.
 */
const post = async (
  parts: Array<{ name: string; value: Buffer | string; filename?: string }>,
  options: { chunkSize?: number; stallAfterBytes?: number; truncate?: number } = {},
): Promise<Attempt> => {
  const pieces: Buffer[] = [];
  for (const part of parts) {
    const disposition =
      part.filename === undefined
        ? `form-data; name="${part.name}"`
        : `form-data; name="${part.name}"; filename="${part.filename}"`;
    pieces.push(
      Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: ${disposition}\r\n\r\n`),
      Buffer.isBuffer(part.value) ? part.value : Buffer.from(part.value),
      Buffer.from('\r\n'),
    );
  }
  pieces.push(Buffer.from(`--${BOUNDARY}--\r\n`));
  let body = Buffer.concat(pieces);
  if (options.truncate !== undefined) body = body.subarray(0, options.truncate);

  const chunkSize = options.chunkSize ?? 64 * 1024;
  let offset = 0;
  let stalled = false;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      // A connection that goes quiet part-way through — a dropped mobile link,
      // a closed laptop lid. It never closes; it simply stops.
      if (options.stallAfterBytes !== undefined && offset >= options.stallAfterBytes && !stalled) {
        stalled = true;
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
      try {
        if (offset >= body.length) {
          controller.close();
          return;
        }
        controller.enqueue(new Uint8Array(body.subarray(offset, offset + chunkSize)));
        offset += chunkSize;
      } catch {
        // The reader gave up on us while we were stalled; nothing left to do.
      }
    },
  });

  const record = beginUpload({ projectRef: 'demo', bytesExpected: body.length });
  const attempt: Attempt = { record };

  const app = new Hono();
  app.post('/videos', async (c) => {
    try {
      attempt.result = await receiveVideoUpload(c, {
        root,
        record,
        exists: (target) => existsSync(target),
      });
    } catch (error) {
      attempt.error = error;
    }
    return c.text('ok');
  });

  await app.request(
    new Request('http://local/videos', {
      method: 'POST',
      headers: {
        'content-type': `multipart/form-data; boundary=${BOUNDARY}`,
        'content-length': String(body.length),
      },
      body: stream,
      // Required by undici for a streaming request body.
      duplex: 'half',
    } as RequestInit),
  );

  return attempt;
};

const sourceDir = (): string => path.join(root, 'source');
const sourceFiles = (): string[] => (existsSync(sourceDir()) ? readdirSync(sourceDir()) : []);

describe('safeFileName', () => {
  it('strips directory traversal and unsafe characters', () => {
    expect(safeFileName('../../etc/passwd')).toBe('passwd');
    expect(safeFileName('/abs/path/game.mp4')).toBe('game.mp4');
    expect(safeFileName('my game (1).mp4')).toBe('my_game__1_.mp4');
  });
});

describe('receiveVideoUpload', () => {
  it('streams a large upload to disk intact', async () => {
    // 12 MB is enough to cross many chunk boundaries without slowing the suite.
    const payload = Buffer.alloc(12 * 1024 * 1024);
    for (let i = 0; i < payload.length; i += 1) payload[i] = i % 251;

    const { result, error, record } = await post([
      { name: 'path', value: '' },
      { name: 'file', value: payload, filename: 'game.mp4' },
    ]);

    expect(error).toBeUndefined();
    expect(result?.savedPath).toBe(path.join(sourceDir(), 'game.mp4'));
    expect(readFileSync(result!.savedPath!).equals(payload)).toBe(true);
    expect(record.fileName).toBe('game.mp4');
    expect(record.bytesReceived).toBeGreaterThan(payload.length);
    // No scratch file left behind.
    expect(sourceFiles()).toEqual(['game.mp4']);
  });

  it('reports no file when the form carried only a server path', async () => {
    const { result, error } = await post([
      { name: 'file', value: '', filename: '' },
      { name: 'path', value: '/data/footage/game.mp4' },
    ]);

    expect(error).toBeUndefined();
    expect(result?.savedPath).toBeNull();
    expect(result?.fields['path']).toBe('/data/footage/game.mp4');
    expect(sourceFiles()).toEqual([]);
  });

  /**
   * Rejecting an unsupported file only after it has been uploaded is the worst
   * possible moment; the extension is known from the part headers, which arrive
   * before a single byte of content.
   */
  it('rejects an unsupported container before storing anything', async () => {
    const { error } = await post([
      { name: 'file', value: Buffer.alloc(1024 * 1024), filename: 'notes.txt' },
    ]);

    expect(error).toBeInstanceOf(UploadError);
    expect((error as UploadError).code).toBe('MEDIA_UNSUPPORTED');
    expect((error as UploadError).status).toBe(415);
    expect(sourceFiles()).toEqual([]);
  });

  it('rejects a name that is already imported', async () => {
    await post([{ name: 'file', value: Buffer.from('first'), filename: 'game.mp4' }]);
    const { error } = await post([
      { name: 'file', value: Buffer.from('second'), filename: 'game.mp4' },
    ]);

    expect((error as UploadError).code).toBe('CONFLICT');
    // The original is untouched.
    expect(readFileSync(path.join(sourceDir(), 'game.mp4')).toString()).toBe('first');
    expect(sourceFiles()).toEqual(['game.mp4']);
  });

  it('enforces the size limit and leaves nothing behind', async () => {
    process.env['REELEEL_MAX_UPLOAD_BYTES'] = String(64 * 1024);

    const { error } = await post(
      [{ name: 'file', value: Buffer.alloc(512 * 1024, 7), filename: 'big.mp4' }],
      { chunkSize: 16 * 1024 },
    );

    expect((error as UploadError).code).toBe('UPLOAD_TOO_LARGE');
    expect((error as UploadError).status).toBe(413);
    expect(sourceFiles()).toEqual([]);
  });

  /**
   * The reported symptom, reproduced: a connection that stops delivering
   * part-way. It must end as a named failure, not a hang and not a bare socket
   * reset, and it must not leave a truncated file that looks importable.
   */
  it('names a stalled connection instead of hanging', async () => {
    process.env['REELEEL_UPLOAD_STALL_SECONDS'] = '0.3';

    const { error, record } = await post(
      [{ name: 'file', value: Buffer.alloc(256 * 1024, 3), filename: 'stalled.mp4' }],
      { chunkSize: 32 * 1024, stallAfterBytes: 96 * 1024 },
    );

    expect(error).toBeInstanceOf(UploadError);
    expect((error as UploadError).code).toBe('UPLOAD_STALLED');
    expect((error as UploadError).status).toBe(408);
    // The record still says how far it got — that is the trackable part.
    expect(record.bytesReceived).toBeGreaterThan(0);
    expect(sourceFiles()).toEqual([]);
  });

  it('cleans up when the body is cut off mid-file', async () => {
    const payload = Buffer.alloc(256 * 1024, 9);
    const { error } = await post([{ name: 'file', value: payload, filename: 'cut.mp4' }], {
      chunkSize: 32 * 1024,
      truncate: 128 * 1024,
    });

    expect(error).toBeInstanceOf(UploadError);
    expect(['UPLOAD_ABORTED', 'MULTIPART_MALFORMED']).toContain((error as UploadError).code);
    expect(sourceFiles()).toEqual([]);
  });

  it('refuses a request that is not multipart', async () => {
    const app = new Hono();
    let caught: unknown;
    app.post('/videos', async (c) => {
      const record = beginUpload({ projectRef: 'demo' });
      try {
        await receiveVideoUpload(c, { root, record });
      } catch (error) {
        caught = error;
      }
      return c.text('ok');
    });

    await app.request('http://local/videos', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });

    expect((caught as UploadError).code).toBe('MULTIPART_UNSUPPORTED');
  });
});
