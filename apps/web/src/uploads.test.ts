import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  beginUpload,
  failUpload,
  finishUpload,
  getUpload,
  getUploadFor,
  importingUpload,
  resetUploads,
  trackUploadProgress,
  usableUploadId,
} from './uploads.js';

// Every state change logs; keep the test output readable.
beforeEach(() => {
  resetUploads();
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('upload records', () => {
  it('is trackable from before the first byte arrives', () => {
    const record = beginUpload({ projectRef: 'demo', bytesExpected: 200 });

    expect(record.status).toBe('receiving');
    expect(record.bytesReceived).toBe(0);
    expect(getUpload(record.id)).toBe(record);
  });

  it('follows an upload through to a successful import', () => {
    const record = beginUpload({ projectRef: 'demo', bytesExpected: 200 });

    trackUploadProgress(record, 140);
    expect(getUpload(record.id)?.bytesReceived).toBe(140);

    importingUpload(record);
    expect(record.status).toBe('importing');

    finishUpload(record);
    expect(record.status).toBe('done');
    expect(record.finishedAt).not.toBeNull();
  });

  /**
   * The point of the whole module: an upload that dies at 70% leaves a record
   * saying so, rather than nothing at all.
   */
  it('keeps the reason and the byte count when an upload fails part-way', () => {
    const record = beginUpload({ projectRef: 'demo', bytesExpected: 200 * 1024 * 1024 });
    trackUploadProgress(record, 140 * 1024 * 1024);

    failUpload(record, {
      code: 'UPLOAD_STALLED',
      error: 'No data received for 120s.',
      hint: 'Check the connection and import the file again.',
    });

    const found = getUpload(record.id);
    expect(found?.status).toBe('failed');
    expect(found?.code).toBe('UPLOAD_STALLED');
    expect(found?.error).toBe('No data received for 120s.');
    expect(found?.hint).not.toBeNull();
    expect(found?.bytesReceived).toBe(140 * 1024 * 1024);
    expect(found?.bytesExpected).toBe(200 * 1024 * 1024);
  });

  it('writes the failure and its stack to the log', () => {
    const written: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    });

    const record = beginUpload({ projectRef: 'demo' });
    failUpload(record, {
      code: 'UPLOAD_WRITE_FAILED',
      error: 'disk died',
      cause: new Error('ENOSPC'),
    });

    const log = written.join('');
    expect(log).toContain(record.id);
    expect(log).toContain('UPLOAD_WRITE_FAILED');
    expect(log).toContain('ENOSPC');
    // The stack is what turns "it failed" into something fixable.
    expect(log).toContain('uploads.test.ts');
  });

  it('only hands a record back to the account that made it', () => {
    const record = beginUpload({ projectRef: 'demo', ownerId: 'user_a' });

    expect(getUploadFor(record.id, 'user_a')).toBe(record);
    expect(getUploadFor(record.id, 'user_b')).toBeUndefined();
    expect(getUploadFor(record.id, undefined)).toBeUndefined();
  });

  it('shares single-user records, which have no owner', () => {
    const record = beginUpload({ projectRef: 'demo' });
    expect(getUploadFor(record.id, undefined)).toBe(record);
  });
});

describe('client-supplied ids', () => {
  it('accepts a well-formed unused id', () => {
    expect(usableUploadId('up_0123456789abcdef')).toBe('up_0123456789abcdef');
  });

  it('rejects anything malformed', () => {
    for (const bad of ['', 'nope', 'up_', 'up_xyz', 'up_' + 'a'.repeat(64), '../etc/passwd']) {
      expect(usableUploadId(bad), bad).toBeUndefined();
    }
    expect(usableUploadId(undefined)).toBeUndefined();
  });

  it('will not let one caller claim another caller\'s id', () => {
    const first = beginUpload({ projectRef: 'demo', id: 'up_00112233' });
    expect(first.id).toBe('up_00112233');

    // Same id proposed again: the second upload gets a server-issued one, so it
    // can never overwrite or read the first.
    const second = beginUpload({ projectRef: 'demo', id: 'up_00112233' });
    expect(second.id).not.toBe(first.id);
    expect(getUpload('up_00112233')).toBe(first);
  });

  it('falls back to a server id when the client offers none', () => {
    expect(beginUpload({ projectRef: 'demo' }).id).toMatch(/^up_[a-f0-9]{16}$/);
  });
});
