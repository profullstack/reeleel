import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  appendChunk,
  cancelSession,
  createSession,
  discardSession,
  findSession,
  onDiskBytes,
  promoteSession,
  renameSession,
} from './chunked.js';
import { UploadError, maxUploadBytes } from './receive.js';
import { resetUploads } from './uploads.js';
import type { UploadRecord } from './uploads.js';

let root: string;

beforeEach(async () => {
  resetUploads();
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  root = await mkdtemp(path.join(tmpdir(), 'reeleel-chunked-'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  delete process.env['REELEEL_MAX_CHUNK_BYTES'];
  delete process.env['REELEEL_MAX_UPLOAD_BYTES'];
  await rm(root, { recursive: true, force: true });
});

const sourceDir = (): string => path.join(root, 'source');
const sourceFiles = (): string[] =>
  existsSync(sourceDir()) ? readdirSync(sourceDir()).sort() : [];

/** A body stream that hands over `data` in fixed slices, like a real socket. */
const streamOf = (data: Buffer, chunkSize = 64 * 1024): ReadableStream<Uint8Array> => {
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= data.length) {
        controller.close();
        return;
      }
      controller.enqueue(new Uint8Array(data.subarray(offset, offset + chunkSize)));
      offset += chunkSize;
    },
  });
};

/** A body that delivers part of `data` and then errors, like a dropped link. */
const brokenStream = (data: Buffer, deliver: number): ReadableStream<Uint8Array> => {
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= deliver) {
        controller.error(new Error('ECONNRESET'));
        return;
      }
      const end = Math.min(sent + 16 * 1024, deliver);
      controller.enqueue(new Uint8Array(data.subarray(sent, end)));
      sent = end;
    },
  });
};

const start = async (fileName: string, size: number): Promise<UploadRecord> =>
  createSession({ root, projectRef: 'demo', fileName, size });

const payload = (bytes: number): Buffer => {
  const data = Buffer.alloc(bytes);
  for (let i = 0; i < bytes; i += 1) data[i] = (i * 7) % 251;
  return data;
};

describe('createSession', () => {
  it('reserves an upload and reports a zero offset to start from', async () => {
    const record = await start('game.mp4', 1024);

    expect(record.status).toBe('receiving');
    expect(record.bytesReceived).toBe(0);
    expect(record.fileName).toBe('game.mp4');
    expect(record.targetPath).toBe(path.join(sourceDir(), 'game.mp4'));
    // Scratch state is keyed by id, so a rename never has to move bytes.
    expect(sourceFiles().some((entry) => entry.includes(record.id))).toBe(true);
  });

  it('rejects an unsupported container before a byte is sent', async () => {
    await expect(start('notes.txt', 1024)).rejects.toMatchObject({
      code: 'MEDIA_UNSUPPORTED',
      status: 415,
    });
  });

  it('rejects a name that is already imported', async () => {
    const record = await start('game.mp4', 4);
    await appendChunk({ record, offset: 0, body: streamOf(payload(4)) });
    await promoteSession(root, record);

    await expect(start('game.mp4', 4)).rejects.toMatchObject({ code: 'CONFLICT', status: 409 });
  });

  // Sizes here are set through the limit rather than written out in gigabytes,
  // so the boundary is asserted without the test needing 10 GB of free disk.
  it('accepts a file right up to the limit', async () => {
    process.env['REELEEL_MAX_UPLOAD_BYTES'] = String(4096);

    const record = await start('game.mp4', 4096);
    expect(record.bytesExpected).toBe(4096);
  });

  it('refuses a file over the limit up front, rather than part-way through', async () => {
    process.env['REELEEL_MAX_UPLOAD_BYTES'] = String(4096);

    await expect(start('huge.mp4', 4097)).rejects.toMatchObject({
      code: 'UPLOAD_TOO_LARGE',
      status: 413,
    });
    // Nothing was reserved for an upload that can never succeed.
    expect(sourceFiles()).toEqual([]);
  });

  it('leaves room for a 10 GB game file by default', () => {
    // Asserted through the ceiling rather than by opening one, so the test does
    // not need 10 GB of free disk to say what it means.
    delete process.env['REELEEL_MAX_UPLOAD_BYTES'];
    expect(maxUploadBytes()).toBeGreaterThanOrEqual(10 * 1024 * 1024 * 1024);
  });

  it('sanitises the destination name', async () => {
    const record = await start('../../etc/evil name.mp4', 16);
    expect(record.fileName).toBe('evil_name.mp4');
    expect(record.targetPath).toBe(path.join(sourceDir(), 'evil_name.mp4'));
  });
});

describe('appendChunk', () => {
  it('assembles a file from sequential chunks', async () => {
    const data = payload(300 * 1024);
    const record = await start('game.mp4', data.length);

    for (let offset = 0; offset < data.length; offset += 100 * 1024) {
      const slice = data.subarray(offset, Math.min(offset + 100 * 1024, data.length));
      await appendChunk({ record, offset, body: streamOf(slice) });
    }

    expect(record.bytesReceived).toBe(data.length);
    const stored = await promoteSession(root, record);
    expect(readFileSync(stored).equals(data)).toBe(true);
  });

  /**
   * The whole reason this module exists. An upload that dies at 70% must carry
   * on at 70% — not restart, and not silently corrupt itself by resuming in the
   * wrong place.
   */
  it('resumes from the exact byte where a dropped connection stopped', async () => {
    const data = payload(200 * 1024);
    const record = await start('game.mp4', data.length);

    // First attempt: the connection dies after 140 kB — 70% of the file.
    await expect(
      appendChunk({ record, offset: 0, body: brokenStream(data, 140 * 1024) }),
    ).rejects.toBeInstanceOf(UploadError);

    // What survived is exactly what was durably written, and it is intact.
    const resumeAt = record.bytesReceived;
    expect(resumeAt).toBeGreaterThan(0);
    expect(resumeAt).toBeLessThanOrEqual(140 * 1024);
    expect(onDiskBytes(record.partPath)).toBe(resumeAt);

    // Second attempt: send only the remainder.
    await appendChunk({ record, offset: resumeAt, body: streamOf(data.subarray(resumeAt)) });

    expect(record.bytesReceived).toBe(data.length);
    const stored = await promoteSession(root, record);
    expect(readFileSync(stored).equals(data)).toBe(true);
  });

  it('refuses a chunk at the wrong offset instead of corrupting the file', async () => {
    const data = payload(64 * 1024);
    const record = await start('game.mp4', data.length);
    await appendChunk({ record, offset: 0, body: streamOf(data.subarray(0, 32 * 1024)) });

    // Replaying the first chunk would duplicate 32 kB into the middle.
    await expect(
      appendChunk({ record, offset: 0, body: streamOf(data.subarray(0, 32 * 1024)) }),
    ).rejects.toMatchObject({ code: 'UPLOAD_OFFSET_MISMATCH', status: 409 });

    // And the error says where to pick up from.
    expect(record.bytesReceived).toBe(32 * 1024);
  });

  it('refuses more data than the upload declared', async () => {
    const record = await start('game.mp4', 1024);
    await expect(
      appendChunk({ record, offset: 0, body: streamOf(payload(4096)) }),
    ).rejects.toMatchObject({ code: 'UPLOAD_TOO_LARGE', status: 413 });
  });

  it('caps a single chunk', async () => {
    process.env['REELEEL_MAX_CHUNK_BYTES'] = String(32 * 1024);
    const record = await start('game.mp4', 1024 * 1024);

    await expect(
      appendChunk({ record, offset: 0, body: streamOf(payload(128 * 1024), 8 * 1024) }),
    ).rejects.toMatchObject({ code: 'UPLOAD_TOO_LARGE' });
  });
});

describe('promoteSession', () => {
  it('will not import an upload that is still missing bytes', async () => {
    const data = payload(64 * 1024);
    const record = await start('game.mp4', data.length);
    await appendChunk({ record, offset: 0, body: streamOf(data.subarray(0, 16 * 1024)) });

    await expect(promoteSession(root, record)).rejects.toMatchObject({
      code: 'UPLOAD_INCOMPLETE',
      status: 409,
    });
    // Nothing that looks importable is left lying around.
    expect(sourceFiles()).not.toContain('game.mp4');
  });

  it('clears the scratch state once the file is in place', async () => {
    const data = payload(4096);
    const record = await start('game.mp4', data.length);
    await appendChunk({ record, offset: 0, body: streamOf(data) });
    await promoteSession(root, record);

    expect(sourceFiles()).toEqual(['game.mp4']);
  });
});

describe('renameSession', () => {
  it('changes the destination without re-sending the bytes', async () => {
    const data = payload(4096);
    const record = await start('game.mp4', data.length);
    await appendChunk({ record, offset: 0, body: streamOf(data) });

    await renameSession({ root, record, fileName: 'first-half.mp4' });

    expect(record.fileName).toBe('first-half.mp4');
    // The bytes never moved: the offset is untouched.
    expect(record.bytesReceived).toBe(data.length);
    const stored = await promoteSession(root, record);
    expect(stored.endsWith('first-half.mp4')).toBe(true);
    expect(readFileSync(stored).equals(data)).toBe(true);
  });

  it('refuses a rename onto a name that already exists', async () => {
    const first = await start('game.mp4', 4);
    await appendChunk({ record: first, offset: 0, body: streamOf(payload(4)) });
    await promoteSession(root, first);

    const second = await start('other.mp4', 4);
    await expect(
      renameSession({ root, record: second, fileName: 'game.mp4' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('refuses a rename to an unsupported container', async () => {
    const record = await start('game.mp4', 4);
    await expect(renameSession({ root, record, fileName: 'game.txt' })).rejects.toMatchObject({
      code: 'MEDIA_UNSUPPORTED',
    });
  });
});

describe('findSession', () => {
  it('rebuilds an upload from disk after the registry has lost it', async () => {
    const data = payload(48 * 1024);
    const record = await start('game.mp4', data.length);
    await appendChunk({ record, offset: 0, body: streamOf(data.subarray(0, 32 * 1024)) });
    const id = record.id;

    // Stands in for a server restart: the bytes remain, the index does not.
    resetUploads();

    const recovered = await findSession(root, id, undefined);
    expect(recovered.id).toBe(id);
    expect(recovered.fileName).toBe('game.mp4');
    expect(recovered.bytesExpected).toBe(data.length);
    // Resume picks up exactly where the interrupted upload stopped.
    expect(recovered.bytesReceived).toBe(32 * 1024);

    await appendChunk({ record: recovered, offset: 32 * 1024, body: streamOf(data.subarray(32 * 1024)) });
    const stored = await promoteSession(root, recovered);
    expect(readFileSync(stored).equals(data)).toBe(true);
  });

  it('does not reveal another account\'s upload', async () => {
    const record = await createSession({
      root,
      projectRef: 'demo',
      ownerId: 'user_a',
      fileName: 'game.mp4',
      size: 16,
    });

    await expect(findSession(root, record.id, 'user_b')).rejects.toMatchObject({ status: 404 });
    await expect(findSession(root, record.id, 'user_a')).resolves.toMatchObject({ id: record.id });
  });

  it('rejects an id that is not an id, rather than touching the filesystem', async () => {
    for (const bad of ['../../etc/passwd', 'up_', 'nope', '']) {
      await expect(findSession(root, bad, undefined)).rejects.toMatchObject({ status: 404 });
    }
  });

  it('reports a genuinely unknown upload as missing', async () => {
    await expect(findSession(root, 'up_00112233', undefined)).rejects.toMatchObject({
      code: 'NOT_FOUND',
      status: 404,
    });
  });
});

describe('cancelSession', () => {
  it('deletes the partial file and its scratch state', async () => {
    const record = await start('game.mp4', 64 * 1024);
    await appendChunk({ record, offset: 0, body: streamOf(payload(16 * 1024)) });
    expect(sourceFiles().length).toBeGreaterThan(0);

    await cancelSession(root, record);

    expect(record.status).toBe('canceled');
    expect(sourceFiles()).toEqual([]);
  });

  it('refuses further chunks once canceled', async () => {
    const record = await start('game.mp4', 64 * 1024);
    await cancelSession(root, record);

    await expect(
      appendChunk({ record, offset: 0, body: streamOf(payload(1024)) }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});

describe('housekeeping', () => {
  it('sweeps scratch files left behind by abandoned uploads', async () => {
    process.env['REELEEL_UPLOAD_STALE_HOURS'] = '0.0001'; // ~0.36s
    const stale = await start('abandoned.mp4', 1024);
    await appendChunk({ record: stale, offset: 0, body: streamOf(payload(512)) });

    await new Promise((resolve) => setTimeout(resolve, 500));
    // Creating any new upload triggers the sweep.
    await start('fresh.mp4', 1024);

    expect(sourceFiles().some((entry) => entry.includes(stale.id))).toBe(false);
    delete process.env['REELEEL_UPLOAD_STALE_HOURS'];
  });

  it('leaves imported footage alone when discarding scratch state', async () => {
    const data = payload(2048);
    const record = await start('game.mp4', data.length);
    await appendChunk({ record, offset: 0, body: streamOf(data) });
    await promoteSession(root, record);

    await discardSession(root, record);

    expect(sourceFiles()).toEqual(['game.mp4']);
  });

  it('ignores a corrupt sidecar rather than crashing the lookup', async () => {
    const record = await start('game.mp4', 1024);
    const sidecar = path
      .join(sourceDir(), `.reeleel-upload-${record.id}.json`);
    await writeFile(sidecar, 'not json', 'utf8');
    resetUploads();

    await expect(findSession(root, record.id, undefined)).rejects.toMatchObject({ status: 404 });
  });

  it('rejects a persisted upload destination outside the source directory', async () => {
    const record = await start('game.mp4', 1024);
    const sidecar = path.join(sourceDir(), `.reeleel-upload-${record.id}.json`);
    const saved = JSON.parse(readFileSync(sidecar, 'utf8')) as Record<string, unknown>;
    await writeFile(sidecar, JSON.stringify({ ...saved, fileName: '../../outside.mp4' }), 'utf8');
    resetUploads();

    await expect(findSession(root, record.id, undefined)).rejects.toMatchObject({ status: 404 });
  });
});
