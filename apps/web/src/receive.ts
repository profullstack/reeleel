/**
 * Receiving uploaded footage.
 *
 * The rules this enforces, in the order they matter:
 *
 *  1. Nothing is buffered. Bytes go from the socket to a `.part` file on disk
 *     via {@link parseMultipart}, so a 200 MB import costs a chunk of memory,
 *     not 860 MB of it.
 *  2. Everything cheap is checked *before* the bytes arrive — extension, name
 *     collision, free disk space — because rejecting a file after the user has
 *     spent ten minutes uploading it is the worst possible time to do it.
 *  3. A stalled connection is detected and named. Node's own `requestTimeout`
 *     would otherwise destroy the socket at five minutes flat with no response
 *     at all, which is indistinguishable from the app crashing.
 *  4. A failed upload never leaves a partial file behind that looks importable.
 */

import { createWriteStream, mkdirSync } from 'node:fs';
import { rename, statfs, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { WriteStream } from 'node:fs';

import type { Context } from 'hono';

import { SUPPORTED_EXTENSIONS, isSupportedExtension, projectDir } from '@reeleel/core';

import { MultipartError, boundaryOf, parseMultipart } from './multipart.js';
import type { FileSink, ReceivedFile } from './multipart.js';
import { nameUpload, trackUploadProgress } from './uploads.js';
import type { UploadRecord } from './uploads.js';

/** A failure with a code the UI and the upload record can both use. */
export class UploadError extends Error {
  readonly code: string;
  readonly hint: string | undefined;
  readonly status: number;

  constructor(
    code: string,
    message: string,
    options: { hint?: string; status?: number; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'UploadError';
    this.code = code;
    this.hint = options.hint;
    this.status = options.status ?? 400;
  }
}

const GIB = 1024 * 1024 * 1024;

const positiveEnv = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

/** Generous by default: this is game footage, not an avatar. */
export const maxUploadBytes = (): number => positiveEnv('REELEEL_MAX_UPLOAD_BYTES', 16 * GIB);

/** How long a connection may deliver nothing before we call it dead. */
export const uploadStallMs = (): number => positiveEnv('REELEEL_UPLOAD_STALL_SECONDS', 120) * 1000;

/** Filenames arrive from a browser and must never escape the project. */
export const safeFileName = (name: string): string =>
  path.basename(name).replace(/[^A-Za-z0-9._-]/g, '_');

/**
 * Fails a silent connection loudly.
 *
 * Without this, a client that opens a request and then goes quiet — a dropped
 * mobile connection, a laptop lid closing mid-upload — holds the handler open
 * until Node destroys the socket, and the user sees a progress bar that simply
 * stops. With it they get UPLOAD_STALLED and an id.
 */
export const withStallTimeout = (
  body: ReadableStream<Uint8Array>,
  ms: number,
): ReadableStream<Uint8Array> => {
  const reader = body.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      let timer: NodeJS.Timeout | undefined;
      try {
        const stalled = new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new UploadError('UPLOAD_STALLED', `No data received for ${ms / 1000}s.`, {
                  hint: 'Check the connection and import the file again.',
                  status: 408,
                }),
              ),
            ms,
          );
        });
        const result = await Promise.race([reader.read(), stalled]);
        if (result.done) {
          controller.close();
          return;
        }
        controller.enqueue(result.value);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    },
    cancel: (reason) => reader.cancel(reason),
  });
};

/** Refuses an upload that cannot possibly fit, rather than filling the disk. */
const assertRoomFor = async (dir: string, bytes: number | null): Promise<void> => {
  if (bytes === null) return;
  let free: number;
  try {
    const stats = await statfs(dir);
    free = stats.bavail * stats.bsize;
  } catch {
    // If the filesystem will not say, let the write find out.
    return;
  }
  // A little headroom: the import also writes a database row and a thumbnail.
  if (free >= bytes * 1.05) return;
  throw new UploadError(
    'DISK_SPACE_LOW',
    `Not enough free space: the upload needs ${Math.ceil(bytes / 1024 / 1024)} MB and ${Math.floor(free / 1024 / 1024)} MB is available.`,
    { hint: 'Free some space or mount a larger volume, then try again.', status: 507 },
  );
};

export interface ReceiveResult {
  /** Absolute path of the saved file, or null when no file part was sent. */
  savedPath: string | null;
  file: ReceivedFile | null;
  fields: Record<string, string>;
}

export interface ReceiveOptions {
  root: string;
  record: UploadRecord;
  /** Rejects a name that is already imported, before any bytes are read. */
  exists?: (target: string) => boolean;
}

/**
 * Streams a multipart upload into the project's `source/` directory.
 *
 * Returns without a `savedPath` when the form carried no file — a browser
 * always sends the file part, empty, even when the user picked nothing.
 */
export const receiveVideoUpload = async (
  c: Context,
  options: ReceiveOptions,
): Promise<ReceiveResult> => {
  const { record, root } = options;

  const boundary = boundaryOf(c.req.header('content-type'));
  if (boundary === null) {
    throw new UploadError('MULTIPART_UNSUPPORTED', 'Expected a multipart/form-data upload.', {
      hint: 'Re-submit the import form.',
      status: 415,
    });
  }

  const body = c.req.raw.body;
  if (body === null) {
    throw new UploadError('UPLOAD_INCOMPLETE', 'The request had no body.', { status: 400 });
  }

  const dir = projectDir(root, 'source');
  let target: string | null = null;
  let partial: string | null = null;
  // Held in an object so the catch block below can see what openFile assigned;
  // TypeScript does not track a plain `let` mutated inside a closure.
  const open: { handle: WriteStream | null } = { handle: null };

  /** Removes a half-written file so it can never be mistaken for footage. */
  const discardPartial = async (): Promise<void> => {
    const scratch = partial;
    partial = null;
    if (scratch === null) return;
    await unlink(scratch).catch(() => undefined);
  };

  const openFile = async (part: { filename: string }): Promise<FileSink | null> => {
    // The browser sends an empty file part when nothing was chosen.
    if (part.filename.length === 0) return null;

    const name = safeFileName(part.filename);
    if (!isSupportedExtension(name)) {
      throw new UploadError(
        'MEDIA_UNSUPPORTED',
        `${path.extname(name) || name} is not a supported container.`,
        { hint: `Supported: ${SUPPORTED_EXTENSIONS.join(', ')}`, status: 415 },
      );
    }

    const candidate = path.join(dir, name);
    if (options.exists?.(candidate) === true) {
      throw new UploadError('CONFLICT', 'A file with that name is already imported.', {
        hint: 'Rename the file, or remove the existing one first.',
        status: 409,
      });
    }

    await assertRoomFor(dir, record.bytesExpected);

    // Uploaded footage has nowhere else to live, so it goes in the project's
    // own source/ directory and is referenced from there.
    mkdirSync(dir, { recursive: true });

    nameUpload(record, name);
    target = candidate;
    // Written under a scratch name so a crash mid-upload cannot leave
    // something that looks like a complete import.
    partial = `${candidate}.${record.id}.part`;
    const handle = createWriteStream(partial);
    open.handle = handle;

    return {
      write: (chunk) =>
        new Promise<void>((resolve, reject) => {
          handle.write(chunk, (error) => {
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
        }),
      end: () =>
        new Promise<void>((resolve, reject) => {
          handle.end((error?: Error | null) => {
            if (error === null || error === undefined) resolve();
            else
              reject(
                new UploadError('UPLOAD_WRITE_FAILED', `Could not finish the upload: ${error.message}`, {
                  status: 500,
                  cause: error,
                }),
              );
          });
        }),
      abort: async () => {
        handle.destroy();
        await discardPartial();
      },
    };
  };

  let parsed;
  try {
    parsed = await parseMultipart(withStallTimeout(body, uploadStallMs()), boundary, {
      openFile,
      maxBytes: maxUploadBytes(),
      onProgress: (bytes) => trackUploadProgress(record, bytes),
    });
  } catch (error) {
    open.handle?.destroy();
    await discardPartial();
    if (error instanceof UploadError) throw error;
    if (error instanceof MultipartError) {
      throw new UploadError(error.code, error.message, {
        ...(error.code === 'UPLOAD_TOO_LARGE'
          ? { hint: `The limit is ${Math.floor(maxUploadBytes() / GIB)} GB per file.` }
          : {}),
        status: error.code === 'UPLOAD_TOO_LARGE' ? 413 : 400,
        cause: error,
      });
    }
    // A client that hangs up mid-upload surfaces here as a stream error. It is
    // still worth a record and a log line — that is how "it failed at 70%"
    // becomes something anyone can look up.
    throw new UploadError('UPLOAD_ABORTED', 'The upload ended before the file was complete.', {
      hint: 'The connection dropped. Import the file again.',
      status: 400,
      cause: error,
    });
  }

  const file = parsed.files.find((candidate) => candidate.bytes > 0) ?? null;
  if (file === null || target === null || partial === null) {
    await discardPartial();
    return { savedPath: null, file: null, fields: parsed.fields };
  }

  // Only now, with every byte on disk, does the file take its real name.
  try {
    await rename(partial, target);
    partial = null;
  } catch (error) {
    await discardPartial();
    throw new UploadError('UPLOAD_WRITE_FAILED', 'Could not store the uploaded file.', {
      status: 500,
      cause: error,
    });
  }

  return { savedPath: target, file, fields: parsed.fields };
};
