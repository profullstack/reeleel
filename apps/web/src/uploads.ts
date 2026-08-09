/**
 * Upload tracking.
 *
 * An upload is the one operation in this app that can fail after the user has
 * already invested twenty minutes of their evening in it, so "it just stopped"
 * is not an acceptable outcome. Every upload gets an id before its first byte
 * is read, every state change is logged against that id, and the record stays
 * queryable at /uploads/:id afterwards. When something goes wrong the user is
 * given a code and an id they can quote, and the operator can find the matching
 * line in the log.
 *
 * The registry is in-process and deliberately so: it is progress telemetry for
 * an in-flight request, not durable state. A restart loses it, and a restart
 * has already lost the upload it describes.
 */

import { newId, nowIso } from '@reeleel/core';

export type UploadStatus = 'receiving' | 'importing' | 'done' | 'failed';

/**
 * Failure codes specific to transport. Anything raised by core keeps its own
 * ReelEelError code instead, so a code always means one thing.
 */
export type UploadFailureCode =
  | 'UPLOAD_TOO_LARGE'
  | 'UPLOAD_STALLED'
  | 'UPLOAD_ABORTED'
  | 'UPLOAD_INCOMPLETE'
  | 'UPLOAD_WRITE_FAILED'
  | 'MULTIPART_MALFORMED'
  | 'MULTIPART_UNSUPPORTED'
  | 'FIELD_TOO_LARGE'
  | 'DISK_SPACE_LOW'
  | 'NO_FILE';

export interface UploadRecord {
  id: string;
  ownerId: string | null;
  projectRef: string;
  fileName: string | null;
  status: UploadStatus;
  bytesReceived: number;
  /** From Content-Length; null when the client did not declare one. */
  bytesExpected: number | null;
  /** Set once the upload ends badly. */
  code: string | null;
  error: string | null;
  hint: string | null;
  startedAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

/** Enough history to still be there when the user reloads and asks what broke. */
const MAX_RECORDS = 200;

const records = new Map<string, UploadRecord>();

const log = (record: UploadRecord, extra?: unknown): void => {
  const detail: Record<string, unknown> = {
    project: record.projectRef,
    file: record.fileName,
    bytes: record.bytesReceived,
    expected: record.bytesExpected,
  };
  if (record.code !== null) detail['code'] = record.code;
  if (record.error !== null) detail['error'] = record.error;
  process.stderr.write(`[upload ${record.id}] ${record.status} ${JSON.stringify(detail)}\n`);
  // A stack is the difference between "it failed" and a fixable bug report.
  if (extra instanceof Error && extra.stack !== undefined) {
    process.stderr.write(`[upload ${record.id}] ${extra.stack}\n`);
  }
};

/** Drops the oldest finished records once the map is full. */
const evict = (): void => {
  if (records.size <= MAX_RECORDS) return;
  for (const [id, record] of records) {
    if (records.size <= MAX_RECORDS) break;
    if (record.finishedAt !== null) records.delete(id);
  }
  // All still in flight — extremely unlikely, but never grow without bound.
  for (const id of records.keys()) {
    if (records.size <= MAX_RECORDS) break;
    records.delete(id);
  }
};

/**
 * A client may name its own upload, which is what makes a *dropped* upload
 * traceable: if the connection dies there is no response to carry an id back,
 * so the browser has to already know the one to ask about. The format is
 * checked and collisions fall back to a server id, so a caller can only ever
 * name its own record.
 */
const CLIENT_ID = /^up_[a-f0-9]{8,32}$/i;

export const usableUploadId = (candidate: string | undefined): string | undefined =>
  candidate !== undefined && CLIENT_ID.test(candidate) && !records.has(candidate)
    ? candidate.toLowerCase()
    : undefined;

export interface BeginUploadInput {
  projectRef: string;
  ownerId?: string | undefined;
  bytesExpected?: number | null;
  /** Proposed by the client; ignored unless it is well-formed and unused. */
  id?: string | undefined;
}

export const beginUpload = (input: BeginUploadInput): UploadRecord => {
  const now = nowIso();
  const record: UploadRecord = {
    id: usableUploadId(input.id) ?? newId('up'),
    ownerId: input.ownerId ?? null,
    projectRef: input.projectRef,
    fileName: null,
    status: 'receiving',
    bytesReceived: 0,
    bytesExpected: input.bytesExpected ?? null,
    code: null,
    error: null,
    hint: null,
    startedAt: now,
    updatedAt: now,
    finishedAt: null,
  };
  records.set(record.id, record);
  evict();
  log(record);
  return record;
};

/**
 * Records progress. Deliberately unlogged — this fires per chunk, and the point
 * of the record is that the client can poll it.
 */
export const trackUploadProgress = (record: UploadRecord, bytesReceived: number): void => {
  record.bytesReceived = bytesReceived;
  record.updatedAt = nowIso();
};

export const nameUpload = (record: UploadRecord, fileName: string): void => {
  record.fileName = fileName;
  record.updatedAt = nowIso();
};

export const importingUpload = (record: UploadRecord): void => {
  record.status = 'importing';
  record.updatedAt = nowIso();
  log(record);
};

export const finishUpload = (record: UploadRecord): UploadRecord => {
  record.status = 'done';
  record.updatedAt = nowIso();
  record.finishedAt = record.updatedAt;
  log(record);
  return record;
};

export interface FailUploadInput {
  code: string;
  error: string;
  hint?: string | undefined;
  cause?: unknown;
}

export const failUpload = (record: UploadRecord, input: FailUploadInput): UploadRecord => {
  record.status = 'failed';
  record.code = input.code;
  record.error = input.error;
  record.hint = input.hint ?? null;
  record.updatedAt = nowIso();
  record.finishedAt = record.updatedAt;
  log(record, input.cause);
  return record;
};

export const getUpload = (id: string): UploadRecord | undefined => records.get(id);

/** Only ever hand back an upload the caller started. */
export const getUploadFor = (id: string, ownerId: string | undefined): UploadRecord | undefined => {
  const record = records.get(id);
  if (record === undefined) return undefined;
  if (record.ownerId === null) return record;
  return record.ownerId === (ownerId ?? null) ? record : undefined;
};

/** Test seam; the registry is process-wide otherwise. */
export const resetUploads = (): void => records.clear();
