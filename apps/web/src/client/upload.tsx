/** @jsxImportSource hono/jsx/dom */
import { render, useEffect, useRef, useState } from 'hono/jsx/dom';

import {
  CHUNK_RETRY_BUDGET_MS,
  IMPORT_RETRY_BUDGET_MS,
  backoffMs,
  isLostAnswer,
  isRetryable,
} from './retry.js';

import { refreshLive } from './live.js';

/**
 * The realtime uploader.
 *
 * Files are sent in chunks at explicit offsets rather than as one long form
 * post, which is what makes the two things this UI promises actually true: the
 * bar moves because the server has *durably stored* that many bytes, and a
 * dropped connection resumes from there instead of starting over. The server
 * decides nothing about presentation; it just reports an offset, and this is
 * the thing that turns an offset into a status bar.
 *
 * It replaces a server-rendered form. With JavaScript off that form still
 * posts, and the server still streams it to disk — this is an upgrade, not a
 * dependency.
 */

const CHUNK = 8 * 1024 * 1024;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => window.setTimeout(resolve, ms));

type Phase =
  | 'queued'
  | 'creating'
  | 'uploading'
  | 'retrying'
  | 'paused'
  | 'importing'
  | 'done'
  | 'failed'
  | 'canceled';

interface Item {
  key: string;
  file: File;
  /** Destination name; editable, which is how a name clash gets fixed. */
  name: string;
  id: string | null;
  offset: number;
  phase: Phase;
  code: string | null;
  error: string | null;
  hint: string | null;
  bytesPerSecond: number;
  /** Set while a chunk is in flight, so pause and cancel can interrupt it. */
  abort: AbortController | null;
  xhr: XMLHttpRequest | null;
}

interface UploadDto {
  id: string;
  fileName: string | null;
  status: string;
  offset: number;
  bytesExpected: number | null;
  code: string | null;
  error: string | null;
  hint: string | null;
}

interface Envelope {
  ok: boolean;
  upload?: UploadDto;
  uploads?: UploadDto[];
  code?: string;
  error?: string;
  hint?: string;
}

const newUploadId = (): string => {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return `up_${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
};

const size = (bytes: number): string => {
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} kB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
};

const clock = (seconds: number): string => {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  const total = Math.round(seconds);
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m ${String(total % 60).padStart(2, '0')}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
};

class ApiError extends Error {
  readonly code: string;
  readonly hint: string | null;
  readonly upload: UploadDto | null;
  /** Kept because the edge answers 502 itself, with none of our codes in it. */
  readonly status: number;

  constructor(body: Envelope, status: number) {
    super(body.error ?? `Request failed (${status})`);
    this.code = body.code ?? `HTTP_${status}`;
    this.hint = body.hint ?? null;
    this.upload = body.upload ?? null;
    this.status = status;
  }
}

const api = async (url: string, init: RequestInit = {}): Promise<Envelope> => {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers: { accept: 'application/json', ...(init.headers ?? {}) },
    });
  } catch {
    // A fetch that never produced a response rejects with a bare TypeError.
    // Reported as a lost connection so callers can tell it apart from a server
    // that answered and said no — one is worth retrying and the other is not.
    throw new ApiError({ ok: false, code: 'NETWORK', error: 'The connection dropped.' }, 0);
  }
  let body: Envelope;
  try {
    body = (await response.json()) as Envelope;
  } catch {
    body = { ok: false, error: `The server returned ${response.status}.` };
  }
  if (!response.ok || !body.ok) throw new ApiError(body, response.status);
  return body;
};

/**
 * One chunk, over XHR rather than fetch — only XHR reports upload progress, and
 * a bar that only moves once per 8 MB is not a status bar.
 */
const putChunk = (
  url: string,
  offset: number,
  blob: Blob,
  onProgress: (sentInChunk: number) => void,
  hold: (xhr: XMLHttpRequest) => void,
): Promise<Envelope> =>
  new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    hold(xhr);
    xhr.open('PUT', url);
    xhr.setRequestHeader('accept', 'application/json');
    xhr.setRequestHeader('content-type', 'application/octet-stream');
    xhr.setRequestHeader('x-upload-offset', String(offset));

    xhr.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable) onProgress(event.loaded);
    });
    xhr.addEventListener('load', () => {
      let body: Envelope;
      try {
        body = JSON.parse(xhr.responseText) as Envelope;
      } catch {
        body = { ok: false, error: `The server returned ${xhr.status}.` };
      }
      if (xhr.status >= 200 && xhr.status < 300 && body.ok) resolve(body);
      else reject(new ApiError(body, xhr.status));
    });
    xhr.addEventListener('error', () =>
      reject(new ApiError({ ok: false, code: 'NETWORK', error: 'The connection dropped.' }, 0)),
    );
    xhr.addEventListener('abort', () =>
      reject(new ApiError({ ok: false, code: 'ABORTED', error: 'Canceled.' }, 0)),
    );
    xhr.send(blob);
  });

const statusLabel = (item: Item): string => {
  switch (item.phase) {
    case 'queued':
      return 'Waiting';
    case 'creating':
      return 'Starting';
    case 'uploading':
      return 'Uploading';
    case 'retrying':
      return 'Retrying';
    case 'paused':
      return 'Paused';
    case 'importing':
      return 'Importing';
    case 'done':
      return 'Imported';
    case 'canceled':
      return 'Canceled';
    default:
      return 'Failed';
  }
};

const Uploader = ({ base }: { base: string }) => {
  const items = useRef<Item[]>([]);
  const [, bump] = useState(0);
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement | null>(null);
  /** Uploads the *server* knows about, which outlive this page. */
  const [remote, setRemote] = useState<UploadDto[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const resumeInput = useRef<HTMLInputElement | null>(null);
  const resumeTarget = useRef<UploadDto | null>(null);
  // The upload driver is imperative and long-lived, so it mutates items in a
  // ref and asks for a repaint, rather than fighting stale closures.
  const paint = (): void => bump((n) => n + 1);

  /**
   * An upload belongs to the server, not to this page. Listing them is what
   * makes an interrupted transfer recoverable at all: after a reload — or a
   * server restart — the bytes are still on disk, but without this the browser
   * would have no idea they existed and the user would start over for nothing.
   */
  const refresh = async (): Promise<void> => {
    try {
      const body = await api(`${base}/uploads`);
      setRemote(body.uploads ?? []);
      setListError(null);
    } catch (error) {
      setListError(error instanceof Error ? error.message : String(error));
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const patch = (key: string, changes: Partial<Item>): void => {
    const found = items.current.find((item) => item.key === key);
    if (found === undefined) return;
    Object.assign(found, changes);
    paint();
  };

  const fail = (key: string, error: unknown): void => {
    const api = error instanceof ApiError ? error : null;
    patch(key, {
      phase: 'failed',
      code: api?.code ?? 'UNKNOWN',
      error: api?.message ?? (error instanceof Error ? error.message : String(error)),
      hint: api?.hint ?? null,
      abort: null,
      xhr: null,
    });
  };

  /** Sends whatever is left of one file, resuming from the server's offset. */
  const drive = async (key: string): Promise<void> => {
    const item = items.current.find((entry) => entry.key === key);
    if (item === undefined) return;

    try {
      if (item.id === null) {
        patch(key, { phase: 'creating', code: null, error: null, hint: null });
        const created = await api(`${base}/uploads`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ fileName: item.name, size: item.file.size, id: newUploadId() }),
        });
        patch(key, { id: created.upload?.id ?? null, offset: created.upload?.offset ?? 0 });
      } else {
        // Resuming: the server is the authority on how far this got.
        const current = await api(`${base}/uploads/${item.id}`);
        patch(key, { offset: current.upload?.offset ?? 0, code: null, error: null, hint: null });
      }

      const live = items.current.find((entry) => entry.key === key);
      if (live?.id == null) return;
      patch(key, { phase: 'uploading' });

      let startedAt = Date.now();
      let startedFrom = live.offset;

      // A chunk that fails is retried in place rather than ending the transfer.
      // The budget is spent per stuck offset and refilled by any forward
      // progress, so a long upload that loses a chunk every few minutes runs to
      // completion while one that is genuinely stuck still gives up.
      let attempt = 0;
      let deadline = Date.now() + CHUNK_RETRY_BUDGET_MS;
      let budgetedFor = -1;

      while (true) {
        const now = items.current.find((entry) => entry.key === key);
        if (now === undefined || now.phase === 'paused' || now.phase === 'canceled') return;
        if (now.offset >= now.file.size) break;

        if (now.offset !== budgetedFor) {
          budgetedFor = now.offset;
          attempt = 0;
          deadline = Date.now() + CHUNK_RETRY_BUDGET_MS;
        }

        const base_ = now.offset;
        const end = Math.min(base_ + CHUNK, now.file.size);
        const slice = now.file.slice(base_, end);

        try {
          const body = await putChunk(
            `${base}/uploads/${now.id}/data`,
            base_,
            slice,
            (sentInChunk) => {
              const elapsed = (Date.now() - startedAt) / 1000;
              const moved = base_ + sentInChunk - startedFrom;
              patch(key, {
                offset: base_ + sentInChunk,
                bytesPerSecond: elapsed > 0.5 ? moved / elapsed : 0,
              });
            },
            (xhr) => patch(key, { xhr }),
          );

          // Trust the server's offset over the browser's idea of what it sent.
          patch(key, {
            offset: body.upload?.offset ?? end,
            xhr: null,
            phase: 'uploading',
            code: null,
            error: null,
            hint: null,
          });

          // Re-baseline the rate occasionally so it tracks the current connection.
          if (Date.now() - startedAt > 10_000) {
            startedAt = Date.now();
            startedFrom = body.upload?.offset ?? end;
          }
        } catch (error) {
          // Pause and Cancel abort the request too; neither is a failure.
          const stopped = items.current.find((entry) => entry.key === key);
          if (stopped === undefined || stopped.phase === 'paused' || stopped.phase === 'canceled') {
            return;
          }
          const failure = error instanceof ApiError ? error : null;
          if (failure === null || !isRetryable(failure.code, failure.status) || Date.now() > deadline) {
            throw error;
          }

          attempt += 1;
          patch(key, {
            phase: 'retrying',
            xhr: null,
            bytesPerSecond: 0,
            code: failure.code,
            error: failure.message,
            hint: failure.hint,
          });
          await sleep(backoffMs(attempt));

          const held = items.current.find((entry) => entry.key === key);
          if (held === undefined || held.phase === 'paused' || held.phase === 'canceled') return;

          // Re-sync before resending. The server's offset is the only truth
          // about where to carry on: the chunk that just failed may have landed
          // in full, in part, or not at all, and only it knows which.
          const state = await api(`${base}/uploads/${held.id}`).catch(() => null);
          const resumeAt = state?.upload?.offset;
          if (typeof resumeAt === 'number') patch(key, { offset: resumeAt, xhr: null });
          startedAt = Date.now();
          startedFrom = typeof resumeAt === 'number' ? resumeAt : base_;
        }
      }

      patch(key, { phase: 'importing', bytesPerSecond: 0, code: null, error: null, hint: null });
      const id = items.current.find((entry) => entry.key === key)?.id;

      // Importing is the one step whose cost grows with the file, so on a large
      // upload it is the likeliest to outlast the connection watching it. Every
      // byte is already stored by this point, so a lost answer is worth asking
      // for again — and the server treats a second ask as the same import.
      let finished: Envelope | null = null;
      let importAttempt = 0;
      const importDeadline = Date.now() + IMPORT_RETRY_BUDGET_MS;
      while (finished === null) {
        let answer: Envelope | null = null;
        try {
          answer = await api(`${base}/uploads/${id}/finish`, { method: 'POST' });
        } catch (error) {
          // Only a missing answer is worth asking again for. An import that ran
          // and failed says so, and repeating it would only fail again.
          const failure = error instanceof ApiError ? error : null;
          if (
            failure === null ||
            !isLostAnswer(failure.code, failure.status) ||
            Date.now() > importDeadline
          ) {
            throw error;
          }
        }

        if (answer?.upload?.status === 'done') {
          finished = answer;
          break;
        }
        // Either the answer was lost, or the import is still running and said
        // so. Both mean the same thing here: wait, then ask how it went.
        if (Date.now() > importDeadline) {
          throw new ApiError(
            { ok: false, code: 'IMPORT_SLOW', error: 'The import is still running. Reload to check on it.' },
            504,
          );
        }
        importAttempt += 1;
        await sleep(backoffMs(importAttempt));
        const state = await api(`${base}/uploads/${id}`).catch(() => null);
        if (state?.upload?.status === 'done') finished = state;
      }

      patch(key, {
        phase: 'done',
        offset: finished.upload?.offset ?? 0,
        name: finished.upload?.fileName ?? item.name,
        code: null,
        error: null,
        hint: null,
      });

      // Everything settled: bring the page's own video list up to date. Swapped
      // in place, so a second upload queued behind this one is not interrupted.
      if (items.current.every((entry) => entry.phase === 'done' || entry.phase === 'canceled')) {
        void refreshLive();
      }
    } catch (error) {
      // A canceled request is a user action, not a failure to report.
      const now = items.current.find((entry) => entry.key === key);
      if (now?.phase === 'paused' || now?.phase === 'canceled') return;
      fail(key, error);
    }
  };

  const add = (files: FileList | File[], adopt?: UploadDto): void => {
    for (const file of Array.from(files)) {
      const key = `${file.name}:${file.size}:${Math.random().toString(36).slice(2)}`;
      items.current.push({
        key,
        file,
        // Adopting keeps the server's chosen name, which may have been renamed.
        name: adopt?.fileName ?? file.name,
        id: adopt?.id ?? null,
        offset: adopt?.offset ?? 0,
        phase: 'queued',
        code: null,
        error: null,
        hint: null,
        bytesPerSecond: 0,
        abort: null,
        xhr: null,
      });
      paint();
      void drive(key);
    }
  };

  // ── Uploads the server is already holding ────────────────────────────────

  /**
   * Picks up an upload started on some earlier visit. The browser cannot reopen
   * a file it was given before — a File handle does not survive a reload — so
   * the user has to point at the same file again. Everything already on the
   * server is kept; only the missing tail is sent.
   */
  const resumeRemote = (dto: UploadDto): void => {
    resumeTarget.current = dto;
    resumeInput.current?.click();
  };

  const onResumeFile = (file: File): void => {
    const dto = resumeTarget.current;
    resumeTarget.current = null;
    if (dto === null) return;

    if (dto.bytesExpected !== null && file.size !== dto.bytesExpected) {
      // Resuming with different bytes would splice two files together and
      // produce a video that is corrupt in a way nothing downstream can see.
      setListError(
        `That file is ${size(file.size)}, but this upload expects ${size(dto.bytesExpected)}. ` +
          'Choose the same file, or delete the upload and start again.',
      );
      return;
    }
    setListError(null);
    setRemote((current) => current.filter((entry) => entry.id !== dto.id));
    add([file], dto);
  };

  const renameRemote = async (dto: UploadDto): Promise<void> => {
    const next = window.prompt('Import this upload as:', dto.fileName ?? '');
    if (next === null || next.trim().length === 0) return;
    try {
      await api(`${base}/uploads/${dto.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fileName: next.trim() }),
      });
      await refresh();
    } catch (error) {
      setListError(error instanceof Error ? error.message : String(error));
    }
  };

  const deleteRemote = async (dto: UploadDto): Promise<void> => {
    const finished = dto.status === 'done';
    const question = finished
      ? 'Clear this upload record? The imported footage is kept.'
      : `Delete this upload? ${size(dto.offset)} already sent will be discarded.`;
    if (!window.confirm(question)) return;
    try {
      await api(`${base}/uploads/${dto.id}`, { method: 'DELETE' });
      await refresh();
    } catch (error) {
      setListError(error instanceof Error ? error.message : String(error));
    }
  };

  /** Retries the import for bytes that are already fully uploaded. */
  const finishRemote = async (dto: UploadDto): Promise<void> => {
    try {
      await api(`${base}/uploads/${dto.id}/finish`, { method: 'POST' });
      await refresh();
      void refreshLive();
    } catch (error) {
      setListError(error instanceof Error ? error.message : String(error));
    }
  };

  const pause = (item: Item): void => {
    item.xhr?.abort();
    patch(item.key, { phase: 'paused', xhr: null, bytesPerSecond: 0 });
  };

  const resume = (item: Item): void => {
    patch(item.key, { phase: 'uploading', code: null, error: null, hint: null });
    void drive(item.key);
  };

  /** Cancel or clear: deletes the upload server-side, then drops the card. */
  const remove = async (item: Item): Promise<void> => {
    item.xhr?.abort();
    patch(item.key, { phase: 'canceled', xhr: null });
    if (item.id !== null) {
      await api(`${base}/uploads/${item.id}`, { method: 'DELETE' }).catch(() => undefined);
    }
    items.current = items.current.filter((entry) => entry.key !== item.key);
    paint();
  };

  /** Renames the destination — the fix for a name clash that costs no bytes. */
  const rename = async (item: Item): Promise<void> => {
    const next = window.prompt('Import this file as:', item.name);
    if (next === null || next.trim().length === 0 || next === item.name) return;
    patch(item.key, { name: next.trim() });
    if (item.id === null) return;
    try {
      const updated = await api(`${base}/uploads/${item.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fileName: next.trim() }),
      });
      patch(item.key, { name: updated.upload?.fileName ?? next.trim(), code: null, error: null });
    } catch (error) {
      fail(item.key, error);
    }
  };

  const onDrop = (event: DragEvent): void => {
    event.preventDefault();
    setDragging(false);
    if (event.dataTransfer?.files != null) add(event.dataTransfer.files);
  };

  const list = items.current;
  const active = list.filter((item) => item.phase !== 'done' && item.phase !== 'canceled');
  const totalBytes = active.reduce((sum, item) => sum + item.file.size, 0);
  const doneBytes = active.reduce((sum, item) => sum + item.offset, 0);
  // Anything this page is already driving is shown as a live card instead.
  const driving = new Set(list.map((item) => item.id).filter((id): id is string => id !== null));
  const stored = remote.filter((dto) => !driving.has(dto.id));

  return (
    <div>
      <div
        class={`dropzone${dragging ? ' dragging' : ''}`}
        onDragOver={(event: DragEvent) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        onClick={() => input.current?.click()}
      >
        <strong>Drop footage here</strong>
        <span class="muted"> or click to choose. Uploads resume if the connection drops.</span>
        <input
          ref={input}
          type="file"
          multiple
          accept="video/mp4,video/quicktime,video/x-matroska,video/webm"
          style="display:none"
          onChange={(event: Event) => {
            const target = event.target as HTMLInputElement;
            if (target.files !== null) add(target.files);
            target.value = '';
          }}
        />
      </div>

      {/* Used only to re-attach a file to an upload the server already holds. */}
      <input
        ref={resumeInput}
        type="file"
        accept="video/mp4,video/quicktime,video/x-matroska,video/webm"
        style="display:none"
        onChange={(event: Event) => {
          const target = event.target as HTMLInputElement;
          const picked = target.files?.[0];
          if (picked !== undefined) onResumeFile(picked);
          target.value = '';
        }}
      />

      {active.length > 1 ? (
        <div class="upload-total">
          <progress max={totalBytes} value={doneBytes} />
          <span class="muted">
            {active.length} files — {size(doneBytes)} of {size(totalBytes)}
          </span>
        </div>
      ) : null}

      {list.map((item) => {
        const percent = item.file.size === 0 ? 0 : item.offset / item.file.size;
        const remaining =
          item.bytesPerSecond > 0 ? (item.file.size - item.offset) / item.bytesPerSecond : Number.NaN;
        const indeterminate = item.phase === 'importing' || item.phase === 'creating';

        return (
          <div class="card upload-item" key={item.key}>
            <div class="row">
              <code class="grow">{item.name}</code>
              <span class={`pill ${item.phase === 'done' ? 'keep' : item.phase === 'failed' ? 'reject' : ''}`}>
                {statusLabel(item)}
              </span>
            </div>

            {indeterminate ? <progress /> : <progress max={1} value={percent} />}

            <div class="row upload-meta">
              <span class="muted grow">
                {item.phase === 'done'
                  ? `${size(item.file.size)} imported`
                  : item.phase === 'importing'
                    ? 'Reading the file with ffprobe…'
                    : `${Math.floor(percent * 100)}% — ${size(item.offset)} of ${size(item.file.size)}` +
                      (item.bytesPerSecond > 0
                        ? ` at ${size(item.bytesPerSecond)}/s, ${clock(remaining)} left`
                        : '')}
              </span>

              {item.phase === 'uploading' || item.phase === 'retrying' ? (
                <button type="button" onClick={() => pause(item)}>
                  Pause
                </button>
              ) : null}
              {item.phase === 'paused' || item.phase === 'failed' ? (
                <button type="button" onClick={() => resume(item)}>
                  Resume
                </button>
              ) : null}
              {item.phase !== 'done' ? (
                <button type="button" onClick={() => void rename(item)}>
                  Rename
                </button>
              ) : null}
              <button type="button" onClick={() => void remove(item)}>
                {item.phase === 'done' ? 'Clear' : 'Cancel'}
              </button>
            </div>

            {item.error === null ? null : (
              // While retrying this is a note about a hiccup being handled, not
              // a failure, so it does not get the alarming colour.
              <p class={`pill upload-error${item.phase === 'retrying' ? '' : ' reject'}`}>
                {item.phase === 'retrying' ? 'Connection lost — retrying. ' : ''}
                {item.error}
                {item.hint === null ? '' : ` ${item.hint}`}
                {item.id === null ? '' : ` — ${item.code}, upload ${item.id}`}
              </p>
            )}
          </div>
        );
      })}

      {/* Uploads the server is holding from an earlier visit. Without this the
          bytes already on disk would be invisible and the user would re-send
          them for nothing. */}
      {stored.length === 0 ? null : (
        <div class="stored-uploads">
          <div class="row">
            <h3 class="grow">Uploads on the server</h3>
            <button type="button" onClick={() => void refresh()}>
              Refresh
            </button>
          </div>

          {stored.map((dto) => {
            const complete = dto.bytesExpected !== null && dto.offset >= dto.bytesExpected;
            return (
              <div class="card upload-item" key={dto.id}>
                <div class="row">
                  <code class="grow">{dto.fileName ?? '(unnamed)'}</code>
                  <span
                    class={`pill ${dto.status === 'done' ? 'keep' : dto.status === 'failed' ? 'reject' : ''}`}
                  >
                    {dto.status}
                  </span>
                </div>

                {dto.status === 'done' ? null : (
                  <progress max={dto.bytesExpected ?? 1} value={dto.offset} />
                )}

                <div class="row upload-meta">
                  <span class="muted grow">
                    {dto.status === 'done'
                      ? `${size(dto.offset)} imported`
                      : `${size(dto.offset)} of ${dto.bytesExpected === null ? '?' : size(dto.bytesExpected)} on the server` +
                        (complete ? ' — ready to import' : ' — needs the rest of the file')}
                  </span>

                  {dto.status !== 'done' && complete ? (
                    <button type="button" onClick={() => void finishRemote(dto)}>
                      Import
                    </button>
                  ) : null}
                  {dto.status !== 'done' && !complete ? (
                    <button type="button" onClick={() => resumeRemote(dto)}>
                      Resume…
                    </button>
                  ) : null}
                  {dto.status === 'done' ? null : (
                    <button type="button" onClick={() => void renameRemote(dto)}>
                      Rename
                    </button>
                  )}
                  <button type="button" onClick={() => void deleteRemote(dto)}>
                    {dto.status === 'done' ? 'Clear' : 'Delete'}
                  </button>
                </div>

                {dto.error === null ? null : (
                  <p class="pill reject upload-error">
                    {dto.error}
                    {dto.hint === null ? '' : ` ${dto.hint}`} — {dto.code}, upload {dto.id}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}

      {listError === null ? null : <p class="pill reject upload-error">{listError}</p>}
    </div>
  );
};

export const mountUploads = (): void => {
  const node = document.getElementById('upload-panel');
  if (node === null) return;
  const base = node.dataset['base'];
  if (base === undefined) return;
  // Everything the driver needs. Without them the server-rendered form is still
  // correct, so bail out quietly rather than breaking the page.
  if (typeof XMLHttpRequest === 'undefined' || typeof crypto?.getRandomValues !== 'function') return;
  if (typeof Blob.prototype.slice !== 'function') return;

  node.innerHTML = '';
  render(<Uploader base={base} />, node);
};
