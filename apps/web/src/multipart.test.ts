import { describe, expect, it } from 'vitest';

import { MultipartError, boundaryOf, parseMultipart } from './multipart.js';
import type { FileSink } from './multipart.js';

const BOUNDARY = '----ReelEelBoundary7MA4YWxkTrZu0gW';

/** Collects a file part in memory — fine for a test, never for a real upload. */
const collector = (): { sink: FileSink; bytes: () => Buffer; ended: () => boolean; aborted: () => boolean } => {
  const chunks: Buffer[] = [];
  let ended = false;
  let aborted = false;
  return {
    sink: {
      write: (chunk) => {
        chunks.push(Buffer.from(chunk));
      },
      end: () => {
        ended = true;
      },
      abort: () => {
        aborted = true;
      },
    },
    bytes: () => Buffer.concat(chunks),
    ended: () => ended,
    aborted: () => aborted,
  };
};

/** Builds a multipart body from parts, exactly as a browser would frame it. */
const build = (
  parts: Array<{ name: string; value: Buffer | string; filename?: string; contentType?: string }>,
): Buffer => {
  const pieces: Buffer[] = [];
  for (const part of parts) {
    const disposition =
      part.filename === undefined
        ? `form-data; name="${part.name}"`
        : `form-data; name="${part.name}"; filename="${part.filename}"`;
    const type = part.contentType === undefined ? '' : `Content-Type: ${part.contentType}\r\n`;
    pieces.push(
      Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: ${disposition}\r\n${type}\r\n`),
      Buffer.isBuffer(part.value) ? part.value : Buffer.from(part.value),
      Buffer.from('\r\n'),
    );
  }
  pieces.push(Buffer.from(`--${BOUNDARY}--\r\n`));
  return Buffer.concat(pieces);
};

/** Delivers a body in fixed-size chunks, the way a socket actually would. */
const streamOf = (body: Buffer, chunkSize: number): ReadableStream<Uint8Array> => {
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= body.length) {
        controller.close();
        return;
      }
      controller.enqueue(new Uint8Array(body.subarray(offset, offset + chunkSize)));
      offset += chunkSize;
    },
  });
};

describe('boundaryOf', () => {
  it('reads a bare boundary', () => {
    expect(boundaryOf(`multipart/form-data; boundary=${BOUNDARY}`)).toBe(BOUNDARY);
  });

  it('reads a quoted boundary', () => {
    expect(boundaryOf('multipart/form-data; boundary="a b c"')).toBe('a b c');
  });

  it('rejects anything that is not multipart/form-data', () => {
    expect(boundaryOf('application/json')).toBeNull();
    expect(boundaryOf('multipart/form-data')).toBeNull();
    expect(boundaryOf(undefined)).toBeNull();
  });
});

describe('parseMultipart', () => {
  it('streams a file part to its sink and decodes plain fields', async () => {
    const payload = Buffer.from('the quick brown fox'.repeat(100));
    const body = build([
      { name: 'path', value: '/data/footage/game.mp4' },
      { name: 'copy', value: 'on' },
      { name: 'file', value: payload, filename: 'game.mp4', contentType: 'video/mp4' },
    ]);
    const file = collector();

    const result = await parseMultipart(streamOf(body, 64), BOUNDARY, {
      openFile: () => file.sink,
    });

    expect(result.fields).toEqual({ path: '/data/footage/game.mp4', copy: 'on' });
    expect(result.files).toEqual([
      { name: 'file', filename: 'game.mp4', contentType: 'video/mp4', bytes: payload.length },
    ]);
    expect(file.bytes().equals(payload)).toBe(true);
    expect(file.ended()).toBe(true);
  });

  /**
   * The failure mode that matters most: a delimiter split across two TCP reads.
   * Parsing every possible split of the same body is a cheap way to be sure the
   * lookbehind never emits a boundary as file content or drops a byte.
   */
  it('produces identical output for every possible chunk split', async () => {
    const payload = Buffer.from('0123456789abcdef'.repeat(8));
    const body = build([
      { name: 'path', value: 'x' },
      { name: 'file', value: payload, filename: 'clip.mp4' },
    ]);

    for (let chunkSize = 1; chunkSize <= body.length; chunkSize += 1) {
      const file = collector();
      const result = await parseMultipart(streamOf(body, chunkSize), BOUNDARY, {
        openFile: () => file.sink,
      });
      expect(result.fields, `chunk size ${chunkSize}`).toEqual({ path: 'x' });
      expect(result.files[0]?.bytes, `chunk size ${chunkSize}`).toBe(payload.length);
      expect(file.bytes().equals(payload), `chunk size ${chunkSize}`).toBe(true);
    }
  });

  it('keeps boundary-like bytes that appear inside the file', async () => {
    // Contains the delimiter prefix without the boundary — the parser must not
    // mistake it for the end of the part.
    const payload = Buffer.concat([
      Buffer.from('before\r\n--'),
      Buffer.from(BOUNDARY.slice(0, 10)),
      Buffer.from('\r\nafter'),
    ]);
    const body = build([{ name: 'file', value: payload, filename: 'tricky.mp4' }]);

    for (const chunkSize of [1, 3, 7, 16, 512]) {
      const file = collector();
      await parseMultipart(streamOf(body, chunkSize), BOUNDARY, { openFile: () => file.sink });
      expect(file.bytes().equals(payload), `chunk size ${chunkSize}`).toBe(true);
    }
  });

  it('discards a part whose sink is refused', async () => {
    const body = build([
      { name: 'file', value: 'ignored bytes', filename: '' },
      { name: 'path', value: '/tmp/game.mp4' },
    ]);

    const result = await parseMultipart(streamOf(body, 8), BOUNDARY, { openFile: () => null });

    expect(result.files).toEqual([]);
    expect(result.fields).toEqual({ path: '/tmp/game.mp4' });
  });

  it('decodes an RFC 5987 filename', async () => {
    const raw = Buffer.concat([
      Buffer.from(
        `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename*=UTF-8''caf%C3%A9%20game.mp4\r\n\r\n`,
      ),
      Buffer.from('data'),
      Buffer.from(`\r\n--${BOUNDARY}--\r\n`),
    ]);

    const file = collector();
    const result = await parseMultipart(streamOf(raw, 16), BOUNDARY, { openFile: () => file.sink });

    expect(result.files[0]?.filename).toBe('café game.mp4');
  });

  it('aborts the sink and reports UPLOAD_TOO_LARGE past the limit', async () => {
    const body = build([
      { name: 'file', value: Buffer.alloc(4096, 0x61), filename: 'big.mp4' },
    ]);
    const file = collector();

    await expect(
      parseMultipart(streamOf(body, 128), BOUNDARY, { openFile: () => file.sink, maxBytes: 1024 }),
    ).rejects.toMatchObject({ code: 'UPLOAD_TOO_LARGE' });

    // A partial file must be cleaned up, not left looking importable.
    expect(file.aborted()).toBe(true);
  });

  it('rejects an oversized non-file field', async () => {
    const body = build([{ name: 'path', value: 'x'.repeat(4096) }]);

    await expect(
      parseMultipart(streamOf(body, 256), BOUNDARY, { openFile: () => null, maxFieldBytes: 64 }),
    ).rejects.toMatchObject({ code: 'FIELD_TOO_LARGE' });
  });

  it('rejects a body that ends before its closing boundary', async () => {
    const body = build([{ name: 'file', value: 'partial', filename: 'cut.mp4' }]);
    const truncated = body.subarray(0, body.length - 30);
    const file = collector();

    const error = await parseMultipart(streamOf(truncated, 16), BOUNDARY, {
      openFile: () => file.sink,
    }).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(MultipartError);
    expect(file.aborted()).toBe(true);
  });

  it('propagates a sink failure unchanged, so a disk error keeps its identity', async () => {
    const body = build([{ name: 'file', value: Buffer.alloc(2048, 1), filename: 'game.mp4' }]);
    const boom = new Error('ENOSPC: no space left on device');

    await expect(
      parseMultipart(streamOf(body, 128), BOUNDARY, {
        openFile: () => ({
          write: () => {
            throw boom;
          },
          end: () => undefined,
          abort: () => undefined,
        }),
      }),
    ).rejects.toBe(boom);
  });

  /**
   * The regression this whole module exists for. `Request.formData()` peaks at
   * roughly 4.3x the upload's size; anything near that here means the streaming
   * path has been lost and large uploads will OOM again.
   */
  it('does not grow with the size of the upload', async () => {
    const size = 128 * 1024 * 1024;
    const chunk = Buffer.alloc(1024 * 1024, 0x62);
    const head = Buffer.from(
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="huge.mp4"\r\n\r\n`,
    );
    const tail = Buffer.from(`\r\n--${BOUNDARY}--\r\n`);

    let sent = 0;
    let received = 0;
    /** Bytes already written to the sink by the time the body was half sent. */
    let deliveredEarly = -1;

    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent === 0) controller.enqueue(new Uint8Array(head));
        if (sent >= size / 2 && deliveredEarly === -1) deliveredEarly = received;
        if (sent < size) {
          controller.enqueue(new Uint8Array(chunk));
          sent += chunk.length;
          return;
        }
        controller.enqueue(new Uint8Array(tail));
        controller.close();
      },
    });

    const before = process.memoryUsage().rss;

    const result = await parseMultipart(body, BOUNDARY, {
      // A sink that counts and discards, standing in for the disk.
      openFile: () => ({
        write: (part) => {
          received += part.length;
        },
        end: () => undefined,
        abort: () => undefined,
      }),
    });

    const growth = process.memoryUsage().rss - before;
    expect(received).toBe(size);
    expect(result.files[0]?.bytes).toBe(size);

    // The property that separates streaming from buffering, and the one that
    // cannot go flaky: most of the file had already reached the sink while the
    // body was still arriving. `Request.formData()` would deliver nothing at
    // all until the last byte was in memory.
    expect(deliveredEarly).toBeGreaterThan(size / 4);

    // Memory is a secondary, noisier check — RSS counts garbage that has not
    // been collected yet. The bar is set where a return to buffering (~4.3x,
    // measured at 550 MB for this size) fails loudly and streaming passes.
    expect(growth).toBeLessThan(size);
  });
});
