/**
 * A streaming multipart/form-data parser.
 *
 * Why this exists rather than `c.req.parseBody()`: Hono's parseBody delegates
 * to `Request.formData()`, which buffers the *entire* body in memory before
 * yielding anything. Measured on Node 24, a 200 MB upload peaks at ~860 MB RSS
 * — the raw body, the decoded part, and the caller's own copy all resident at
 * once. That memory is external (ArrayBuffer), not V8 heap, so it does not
 * raise a catchable "heap out of memory"; the container's OOM killer takes the
 * process instead. The upload dies mid-flight with no response, no log and no
 * stack trace, which is exactly the failure this parser removes.
 *
 * Here, file parts are handed to a sink as they arrive and never accumulate.
 * Peak memory is one chunk plus the boundary-sized lookbehind, whatever the
 * upload's size.
 */

export type MultipartErrorCode =
  | 'MULTIPART_MALFORMED'
  | 'MULTIPART_UNSUPPORTED'
  | 'UPLOAD_TOO_LARGE'
  | 'FIELD_TOO_LARGE';

export class MultipartError extends Error {
  readonly code: MultipartErrorCode;

  constructor(code: MultipartErrorCode, message: string, options: { cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'MultipartError';
    this.code = code;
  }
}

export interface FilePart {
  /** The form field name, e.g. `file`. */
  name: string;
  /** As supplied by the browser. Never trust it as a path. */
  filename: string;
  contentType: string | undefined;
}

/**
 * Where a file part's bytes go. `write` must respect backpressure — the parser
 * awaits it, which is what stops a fast uploader outrunning a slow disk.
 */
export interface FileSink {
  write: (chunk: Uint8Array) => Promise<void> | void;
  end: () => Promise<void> | void;
  /** Called instead of `end` when the upload fails; clean up partial state. */
  abort: (error: unknown) => Promise<void> | void;
}

export interface ReceivedFile {
  name: string;
  filename: string;
  contentType: string | undefined;
  bytes: number;
}

export interface ParsedMultipart {
  /** Non-file parts, decoded as UTF-8. */
  fields: Record<string, string>;
  files: ReceivedFile[];
  /** Total bytes consumed from the wire, including boundaries and headers. */
  bytesRead: number;
}

export interface ParseMultipartOptions {
  /**
   * Opens a sink for a file part. Return `null` to discard the part's bytes —
   * used for the empty file input a browser sends when nothing was chosen.
   */
  openFile: (part: FilePart) => Promise<FileSink | null> | FileSink | null;
  /** Hard cap on the whole body. Exceeding it aborts with UPLOAD_TOO_LARGE. */
  maxBytes?: number;
  /** Cap on a single non-file field, which is buffered. Default 1 MiB. */
  maxFieldBytes?: number;
  /** Cap on one part's header block. Default 32 KiB. */
  maxHeaderBytes?: number;
  /** Called as bytes arrive, for progress reporting. */
  onProgress?: (bytesRead: number) => void;
}

const CRLF = Buffer.from('\r\n');
const DOUBLE_CRLF = Buffer.from('\r\n\r\n');
const DASH_DASH = Buffer.from('--');

/**
 * Pulls the boundary out of the Content-Type header. RFC 2046 allows it to be
 * quoted, and browsers differ, so both forms are accepted.
 */
export const boundaryOf = (contentType: string | undefined): string | null => {
  if (contentType === undefined) return null;
  if (!/^\s*multipart\/form-data\s*(;|$)/i.test(contentType)) return null;
  const match = /;\s*boundary=(?:"([^"]*)"|([^\s;]+))/i.exec(contentType);
  const value = match?.[1] ?? match?.[2];
  return value === undefined || value.length === 0 ? null : value;
};

/** Unescapes an RFC 2616 quoted-string, or returns a bare token unchanged. */
const unquote = (value: string): string =>
  value.startsWith('"') && value.endsWith('"') && value.length >= 2
    ? value.slice(1, -1).replace(/\\(.)/g, '$1')
    : value;

interface PartHeaders {
  name: string | null;
  filename: string | null;
  contentType: string | undefined;
}

const parsePartHeaders = (block: string): PartHeaders => {
  let name: string | null = null;
  let filename: string | null = null;
  let contentType: string | undefined;

  for (const line of block.split('\r\n')) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const header = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    if (header === 'content-type') {
      contentType = value;
      continue;
    }
    if (header !== 'content-disposition') continue;

    const nameMatch = /;\s*name=("(?:[^"\\]|\\.)*"|[^;]*)/i.exec(value);
    if (nameMatch?.[1] !== undefined) name = unquote(nameMatch[1].trim());

    // `filename*` (RFC 5987) wins over `filename` when a client sends both.
    const extended = /;\s*filename\*=\s*([^;]+)/i.exec(value);
    if (extended?.[1] !== undefined) {
      const encoded = extended[1].trim();
      const parts = encoded.split("'");
      const raw = parts.length >= 3 ? parts.slice(2).join("'") : encoded;
      try {
        filename = decodeURIComponent(raw);
      } catch {
        filename = raw;
      }
    } else {
      const plain = /;\s*filename=("(?:[^"\\]|\\.)*"|[^;]*)/i.exec(value);
      if (plain?.[1] !== undefined) filename = unquote(plain[1].trim());
    }
  }

  return { name, filename, contentType };
};

type State = 'seek' | 'headers' | 'body' | 'done';

/**
 * Parses `body` as multipart/form-data, streaming file parts into sinks.
 *
 * Throws MultipartError for anything the caller can act on; a sink's own
 * failure propagates unchanged so a disk error keeps its identity.
 */
export const parseMultipart = async (
  body: ReadableStream<Uint8Array>,
  boundary: string,
  options: ParseMultipartOptions,
): Promise<ParsedMultipart> => {
  const maxBytes = options.maxBytes ?? Number.POSITIVE_INFINITY;
  const maxFieldBytes = options.maxFieldBytes ?? 1024 * 1024;
  const maxHeaderBytes = options.maxHeaderBytes ?? 32 * 1024;

  // Every part is preceded by CRLF + "--boundary". The opening boundary has no
  // leading CRLF, so we seed the buffer with one and search uniformly.
  const delimiter = Buffer.concat([CRLF, DASH_DASH, Buffer.from(boundary)]);
  let buffer: Buffer = Buffer.from(CRLF);

  const fields: Record<string, string> = {};
  const files: ReceivedFile[] = [];
  let bytesRead = 0;
  let state: State = 'seek';

  // Current part.
  let sink: FileSink | null = null;
  let current: PartHeaders | null = null;
  let fieldChunks: Buffer[] = [];
  let fieldBytes = 0;
  let fileBytes = 0;

  const openSinks = new Set<FileSink>();

  const abortAll = async (error: unknown): Promise<void> => {
    for (const open of openSinks) {
      try {
        await open.abort(error);
      } catch {
        // The original failure is the one worth reporting.
      }
    }
    openSinks.clear();
  };

  /** Appends body bytes to whichever destination the current part uses. */
  const emit = async (chunk: Buffer): Promise<void> => {
    if (chunk.length === 0) return;
    if (sink !== null) {
      fileBytes += chunk.length;
      await sink.write(chunk);
      return;
    }
    if (current?.filename !== null) return; // discarded file part
    fieldBytes += chunk.length;
    if (fieldBytes > maxFieldBytes) {
      throw new MultipartError(
        'FIELD_TOO_LARGE',
        `Form field "${current?.name ?? '?'}" exceeds ${maxFieldBytes} bytes.`,
      );
    }
    fieldChunks.push(chunk);
  };

  const finishPart = async (): Promise<void> => {
    if (sink !== null) {
      await sink.end();
      openSinks.delete(sink);
      files.push({
        name: current?.name ?? '',
        filename: current?.filename ?? '',
        contentType: current?.contentType,
        bytes: fileBytes,
      });
    } else if (current !== null && current.filename === null && current.name !== null) {
      fields[current.name] = Buffer.concat(fieldChunks).toString('utf8');
    }
    sink = null;
    current = null;
    fieldChunks = [];
    fieldBytes = 0;
    fileBytes = 0;
  };

  /**
   * Drains `buffer` as far as it can and reports where the machine stopped.
   * `final` tells it the stream has ended, so a truncated body is an error
   * rather than a request for more bytes.
   */
  const drain = async (final: boolean): Promise<State> => {
    for (;;) {
      if (state === 'done') return state;

      if (state === 'seek') {
        const at = buffer.indexOf(delimiter);
        if (at === -1) {
          // Nothing here yet; keep only what could be a partial delimiter.
          const keep = delimiter.length - 1;
          if (buffer.length > keep) buffer = buffer.subarray(buffer.length - keep);
          if (final) throw new MultipartError('MULTIPART_MALFORMED', 'No closing boundary.');
          return state;
        }
        const rest = buffer.subarray(at + delimiter.length);
        if (rest.length < 2) {
          if (!final) {
            buffer = buffer.subarray(at);
            return state;
          }
          throw new MultipartError('MULTIPART_MALFORMED', 'Truncated boundary.');
        }
        if (rest[0] === 0x2d && rest[1] === 0x2d) {
          state = 'done'; // closing "--boundary--"
          return state;
        }
        // Transport padding may follow the boundary, up to the line break.
        const eol = rest.indexOf(CRLF);
        if (eol === -1) {
          if (!final) {
            buffer = buffer.subarray(at);
            return state;
          }
          throw new MultipartError('MULTIPART_MALFORMED', 'Boundary without a line break.');
        }
        buffer = rest.subarray(eol + 2);
        state = 'headers';
        continue;
      }

      if (state === 'headers') {
        const end = buffer.indexOf(DOUBLE_CRLF);
        if (end === -1) {
          if (buffer.length > maxHeaderBytes) {
            throw new MultipartError('MULTIPART_MALFORMED', 'Part headers are too large.');
          }
          if (final) throw new MultipartError('MULTIPART_MALFORMED', 'Truncated part headers.');
          return state;
        }
        if (end > maxHeaderBytes) {
          throw new MultipartError('MULTIPART_MALFORMED', 'Part headers are too large.');
        }
        current = parsePartHeaders(buffer.subarray(0, end).toString('utf8'));
        buffer = buffer.subarray(end + DOUBLE_CRLF.length);

        if (current.filename !== null) {
          const opened = await options.openFile({
            name: current.name ?? '',
            filename: current.filename,
            contentType: current.contentType,
          });
          sink = opened;
          if (opened !== null) openSinks.add(opened);
        }
        state = 'body';
        continue;
      }

      // state === 'body'
      const at = buffer.indexOf(delimiter);
      if (at === -1) {
        // Anything that cannot be the start of a delimiter is safe to emit.
        const safe = buffer.length - (delimiter.length - 1);
        if (safe > 0) {
          const chunk = buffer.subarray(0, safe);
          buffer = buffer.subarray(safe);
          await emit(chunk);
        }
        if (final) throw new MultipartError('MULTIPART_MALFORMED', 'Part is missing its boundary.');
        return state;
      }
      const chunk = buffer.subarray(0, at);
      buffer = buffer.subarray(at);
      await emit(chunk);
      await finishPart();
      state = 'seek';
    }
  };

  const reader = body.getReader();
  let complete = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined || value.length === 0) continue;

      bytesRead += value.length;
      if (bytesRead > maxBytes) {
        throw new MultipartError(
          'UPLOAD_TOO_LARGE',
          `Upload exceeds the ${maxBytes} byte limit.`,
        );
      }
      options.onProgress?.(bytesRead);

      buffer = buffer.length === 0 ? Buffer.from(value) : Buffer.concat([buffer, value]);
      complete = (await drain(false)) === 'done';
      if (complete) break;
    }
    if (!complete) await drain(true);
  } catch (error) {
    await abortAll(error);
    // Stop the client uploading into a request we have already given up on.
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }

  return { fields, files, bytesRead };
};
