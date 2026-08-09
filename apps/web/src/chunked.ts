/**
 * Resumable, chunked uploads.
 *
 * The one-shot form post in receive.ts is correct but fragile in a way no
 * server-side fix can reach: it is a single request, so any interruption at any
 * point costs the entire transfer. For a 200 MB import over a home connection
 * that is a twenty-minute loss, and the natural response to losing it twice is
 * to stop using the app.
 *
 * So the browser sends the file in chunks instead. Each chunk is its own short
 * request appended to a scratch file at a known offset, which buys three
 * things: no single request is long-lived (timeouts stop mattering), an
 * interruption costs one chunk rather than the file, and the offset already on
 * disk *is* the resume point — an upload that died at 70% carries on at 70%.
 *
 * State lives beside the bytes. A sidecar next to the part file records what
 * the upload is for, so a server restart loses the in-memory index but not the
 * upload; the client asks where it got to and continues.
 */

import { createWriteStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { readFile, readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { SUPPORTED_EXTENSIONS, isSupportedExtension, projectDir } from '@reeleel/core';

import { UploadError, assertRoomFor, safeFileName, uploadStallMs, withStallTimeout } from './receive.js';
import {
  beginUpload,
  cancelUpload,
  failUpload,
  getUpload,
  nameUpload,
  trackUploadProgress,
} from './uploads.js';
import type { UploadRecord } from './uploads.js';

/** Scratch files are keyed by upload id, not by name, so a rename is free. */
const PREFIX = '.reeleel-upload-';

const partPathFor = (root: string, id: string): string =>
  path.join(projectDir(root, 'source'), `${PREFIX}${id}.part`);

const sidecarPathFor = (root: string, id: string): string =>
  path.join(projectDir(root, 'source'), `${PREFIX}${id}.json`);

/** What has to survive a restart for an upload to still be resumable. */
interface Sidecar {
  id: string;
  ownerId: string | null;
  projectRef: string;
  fileName: string;
  bytesExpected: number;
  startedAt: string;
}

const positiveEnv = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

/** A single chunk. Large enough to be efficient, small enough to retry cheaply. */
export const maxChunkBytes = (): number => positiveEnv('REELEEL_MAX_CHUNK_BYTES', 64 * 1024 * 1024);

/** Abandoned scratch files are swept after this long. Default 48 hours. */
const staleAfterMs = (): number => positiveEnv('REELEEL_UPLOAD_STALE_HOURS', 48) * 3600 * 1000;

const requireId = (id: string): string => {
  // Ids reach the filesystem, so nothing but the known shape is allowed near it.
  if (!/^up_[a-f0-9]{8,32}$/i.test(id)) {
    throw new UploadError('NOT_FOUND', 'No such upload.', { status: 404 });
  }
  return id.toLowerCase();
};

/** Clears scratch files whose uploads were abandoned rather than finished. */
const sweepStale = async (root: string): Promise<void> => {
  const dir = projectDir(root, 'source');
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }
  const cutoff = Date.now() - staleAfterMs();
  await Promise.all(
    entries
      .filter((entry) => entry.startsWith(PREFIX))
      .map(async (entry) => {
        const full = path.join(dir, entry);
        try {
          const stats = await stat(full);
          if (stats.mtimeMs < cutoff) await rm(full, { force: true });
        } catch {
          // Raced with another sweep, or already gone. Either is fine.
        }
      }),
  );
};

export interface CreateSessionInput {
  root: string;
  projectRef: string;
  ownerId?: string | undefined;
  fileName: string;
  size: number;
  /** Proposed by the client so a dropped response is still traceable. */
  id?: string | undefined;
  exists?: (target: string) => boolean;
}

/**
 * Opens an upload. Everything that can be checked cheaply is checked here,
 * before a single byte is sent — rejecting a 200 MB file after it has arrived
 * is the worst possible moment to do it.
 */
export const createSession = async (input: CreateSessionInput): Promise<UploadRecord> => {
  const name = safeFileName(input.fileName);
  if (name.length === 0) {
    throw new UploadError('NO_FILE', 'The upload needs a file name.', { status: 400 });
  }
  if (!isSupportedExtension(name)) {
    throw new UploadError(
      'MEDIA_UNSUPPORTED',
      `${path.extname(name) || name} is not a supported container.`,
      { hint: `Supported: ${SUPPORTED_EXTENSIONS.join(', ')}`, status: 415 },
    );
  }
  if (!Number.isFinite(input.size) || input.size <= 0) {
    throw new UploadError('INVALID_INPUT', 'The upload needs a positive size.', { status: 400 });
  }

  const dir = projectDir(input.root, 'source');
  const target = path.join(dir, name);
  const exists = input.exists ?? ((candidate: string) => existsSync(candidate));
  if (exists(target)) {
    throw new UploadError('CONFLICT', 'A file with that name is already imported.', {
      hint: 'Rename this upload, or remove the existing file first.',
      status: 409,
    });
  }

  mkdirSync(dir, { recursive: true });
  await assertRoomFor(dir, input.size);
  await sweepStale(input.root);

  const record = beginUpload({
    projectRef: input.projectRef,
    ownerId: input.ownerId,
    bytesExpected: input.size,
    fileName: name,
    ...(input.id === undefined ? {} : { id: input.id }),
  });
  record.partPath = partPathFor(input.root, record.id);
  record.targetPath = target;

  const sidecar: Sidecar = {
    id: record.id,
    ownerId: record.ownerId,
    projectRef: record.projectRef,
    fileName: name,
    bytesExpected: input.size,
    startedAt: record.startedAt,
  };
  await writeFile(sidecarPathFor(input.root, record.id), JSON.stringify(sidecar), 'utf8');

  return record;
};

/**
 * Finds an upload, rebuilding it from disk when the in-memory index has lost it
 * — which is exactly what happens across a server restart, and precisely when
 * being able to resume matters most.
 */
export const findSession = async (
  root: string,
  id: string,
  ownerId: string | undefined,
): Promise<UploadRecord> => {
  const safe = requireId(id);
  const known = getUpload(safe);
  if (known !== undefined) {
    if (known.ownerId !== null && known.ownerId !== (ownerId ?? null)) {
      // Report it as missing rather than as forbidden: one account should not
      // be able to probe for another's upload ids.
      throw new UploadError('NOT_FOUND', 'No such upload.', { status: 404 });
    }
    return known;
  }

  let sidecar: Sidecar;
  try {
    sidecar = JSON.parse(await readFile(sidecarPathFor(root, safe), 'utf8')) as Sidecar;
  } catch {
    throw new UploadError('NOT_FOUND', 'No such upload.', { status: 404 });
  }
  if (sidecar.ownerId !== null && sidecar.ownerId !== (ownerId ?? null)) {
    throw new UploadError('NOT_FOUND', 'No such upload.', { status: 404 });
  }

  const record = beginUpload({
    id: sidecar.id,
    projectRef: sidecar.projectRef,
    ownerId: sidecar.ownerId ?? undefined,
    bytesExpected: sidecar.bytesExpected,
    fileName: sidecar.fileName,
    partPath: partPathFor(root, safe),
    targetPath: path.join(projectDir(root, 'source'), sidecar.fileName),
    quiet: true,
  });
  // The bytes on disk are the truth about how far this upload got.
  record.bytesReceived = onDiskBytes(record.partPath);
  return record;
};

/** The authoritative resume offset: what is actually on disk right now. */
export const onDiskBytes = (partPath: string | null): number => {
  if (partPath === null) return 0;
  try {
    return statSync(partPath).size;
  } catch {
    return 0;
  }
};

export interface AppendInput {
  record: UploadRecord;
  offset: number;
  body: ReadableStream<Uint8Array>;
}

/**
 * Appends one chunk at `offset`. The offset must match what is already stored,
 * which makes a duplicated or out-of-order chunk a loud error rather than a
 * silently corrupted video.
 */
export const appendChunk = async (input: AppendInput): Promise<UploadRecord> => {
  const { record } = input;
  if (record.partPath === null) {
    throw new UploadError('INVALID_INPUT', 'This upload does not accept chunks.', { status: 400 });
  }
  if (record.status === 'done' || record.status === 'importing') {
    throw new UploadError('CONFLICT', 'This upload has already been finished.', { status: 409 });
  }
  if (record.status === 'canceled') {
    throw new UploadError('CONFLICT', 'This upload was canceled.', { status: 409 });
  }
  if (record.writing) {
    throw new UploadError('CONFLICT', 'Another chunk is already being written.', { status: 409 });
  }

  const stored = onDiskBytes(record.partPath);
  if (input.offset !== stored) {
    throw new UploadError(
      'UPLOAD_OFFSET_MISMATCH',
      `Expected the next chunk at ${stored}, not ${input.offset}.`,
      { hint: 'Read the upload to get its current offset and resume from there.', status: 409 },
    );
  }

  const limit = record.bytesExpected;
  if (limit !== null && stored >= limit) {
    throw new UploadError('CONFLICT', 'The upload is already complete.', { status: 409 });
  }

  record.writing = true;
  const maxChunk = maxChunkBytes();
  // 'r+' preserves what is already there; 'w' creates the file on the first chunk.
  const handle = createWriteStream(record.partPath, {
    flags: stored === 0 ? 'w' : 'r+',
    start: stored,
  });
  let written = 0;

  const reader = withStallTimeout(input.body, uploadStallMs()).getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined || value.length === 0) continue;

      written += value.length;
      if (written > maxChunk) {
        throw new UploadError('UPLOAD_TOO_LARGE', `A chunk may not exceed ${maxChunk} bytes.`, {
          status: 413,
        });
      }
      if (limit !== null && stored + written > limit) {
        throw new UploadError(
          'UPLOAD_TOO_LARGE',
          'The upload sent more data than it declared.',
          { status: 413 },
        );
      }

      await new Promise<void>((resolve, reject) => {
        handle.write(value, (error) => {
          if (error === null || error === undefined) resolve();
          else
            reject(
              new UploadError('UPLOAD_WRITE_FAILED', `Could not write the upload: ${error.message}`, {
                hint: 'Check free disk space and permissions on the project directory.',
                status: 500,
                cause: error,
              }),
            );
        });
      });
      // Progress is reported from what is durably written, never from what was
      // merely received, so a resume never skips bytes that were lost in flight.
      trackUploadProgress(record, stored + written);
    }

    await new Promise<void>((resolve, reject) => {
      handle.end((error?: Error | null) => {
        if (error === null || error === undefined) resolve();
        else reject(new UploadError('UPLOAD_WRITE_FAILED', error.message, { status: 500, cause: error }));
      });
    });
  } catch (error) {
    handle.destroy();
    await reader.cancel(error).catch(() => undefined);
    // The chunk failed, but everything before it is still good on disk — this
    // is a resumable setback, not the end of the upload.
    trackUploadProgress(record, onDiskBytes(record.partPath));
    const failure =
      error instanceof UploadError
        ? error
        : new UploadError('UPLOAD_ABORTED', 'The chunk did not arrive completely.', {
            hint: 'Resume from the offset in the upload record.',
            status: 400,
            cause: error,
          });
    failUpload(record, {
      code: failure.code,
      error: failure.message,
      hint: failure.hint,
      cause: error,
    });
    throw failure;
  } finally {
    record.writing = false;
    reader.releaseLock();
  }

  trackUploadProgress(record, onDiskBytes(record.partPath));
  return record;
};

export interface RenameInput {
  root: string;
  record: UploadRecord;
  fileName: string;
  exists?: (target: string) => boolean;
}

/**
 * Renames an upload's destination. Worth having on its own: a name collision is
 * the one rejection a user can fix without re-sending 200 MB, and only if we
 * let them change the name of an upload that is already on disk.
 */
export const renameSession = async (input: RenameInput): Promise<UploadRecord> => {
  const { record } = input;
  if (record.status === 'done') {
    throw new UploadError('CONFLICT', 'This upload has already been imported.', { status: 409 });
  }
  const name = safeFileName(input.fileName);
  if (name.length === 0) {
    throw new UploadError('INVALID_INPUT', 'The upload needs a file name.', { status: 400 });
  }
  if (!isSupportedExtension(name)) {
    throw new UploadError(
      'MEDIA_UNSUPPORTED',
      `${path.extname(name) || name} is not a supported container.`,
      { hint: `Supported: ${SUPPORTED_EXTENSIONS.join(', ')}`, status: 415 },
    );
  }

  const target = path.join(projectDir(input.root, 'source'), name);
  const exists = input.exists ?? ((candidate: string) => existsSync(candidate));
  if (target !== record.targetPath && exists(target)) {
    throw new UploadError('CONFLICT', 'A file with that name is already imported.', {
      status: 409,
    });
  }

  nameUpload(record, name, target);
  // Keep the sidecar truthful so a restart resumes under the new name.
  if (record.bytesExpected !== null) {
    const sidecar: Sidecar = {
      id: record.id,
      ownerId: record.ownerId,
      projectRef: record.projectRef,
      fileName: name,
      bytesExpected: record.bytesExpected,
      startedAt: record.startedAt,
    };
    await writeFile(sidecarPathFor(input.root, record.id), JSON.stringify(sidecar), 'utf8').catch(
      () => undefined,
    );
  }
  return record;
};

/** Moves the completed scratch file into place. Throws if bytes are missing. */
export const promoteSession = async (root: string, record: UploadRecord): Promise<string> => {
  if (record.partPath === null || record.targetPath === null) {
    throw new UploadError('INVALID_INPUT', 'This upload has nothing to import.', { status: 400 });
  }
  const stored = onDiskBytes(record.partPath);
  if (record.bytesExpected !== null && stored !== record.bytesExpected) {
    throw new UploadError(
      'UPLOAD_INCOMPLETE',
      `Only ${stored} of ${record.bytesExpected} bytes have arrived.`,
      { hint: 'Resume the upload from its current offset before finishing it.', status: 409 },
    );
  }
  try {
    await rename(record.partPath, record.targetPath);
  } catch (error) {
    throw new UploadError('UPLOAD_WRITE_FAILED', 'Could not store the uploaded file.', {
      status: 500,
      cause: error,
    });
  }
  await unlink(sidecarPathFor(root, record.id)).catch(() => undefined);
  return record.targetPath;
};

/** Puts the file back in scratch so a failed import can be retried or renamed. */
export const demoteSession = async (record: UploadRecord): Promise<void> => {
  if (record.partPath === null || record.targetPath === null) return;
  await rename(record.targetPath, record.partPath).catch(() => undefined);
};

/** Deletes an upload's scratch state. The imported file, if any, is left alone. */
export const discardSession = async (root: string, record: UploadRecord): Promise<void> => {
  if (record.partPath !== null) await rm(record.partPath, { force: true }).catch(() => undefined);
  await rm(sidecarPathFor(root, record.id), { force: true }).catch(() => undefined);
};

export const cancelSession = async (root: string, record: UploadRecord): Promise<UploadRecord> => {
  await discardSession(root, record);
  return cancelUpload(record);
};
