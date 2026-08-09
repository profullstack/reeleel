/** @jsxImportSource hono/jsx/dom */
import { render, useRef, useState } from 'hono/jsx/dom';

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

type Phase =
  | 'queued'
  | 'creating'
  | 'uploading'
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

  constructor(body: Envelope, status: number) {
    super(body.error ?? `Request failed (${status})`);
    this.code = body.code ?? `HTTP_${status}`;
    this.hint = body.hint ?? null;
    this.upload = body.upload ?? null;
  }
}

const api = async (url: string, init: RequestInit = {}): Promise<Envelope> => {
  const response = await fetch(url, {
    ...init,
    headers: { accept: 'application/json', ...(init.headers ?? {}) },
  });
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
  // The upload driver is imperative and long-lived, so it mutates items in a
  // ref and asks for a repaint, rather than fighting stale closures.
  const paint = (): void => bump((n) => n + 1);

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

      while (true) {
        const now = items.current.find((entry) => entry.key === key);
        if (now === undefined || now.phase === 'paused' || now.phase === 'canceled') return;
        if (now.offset >= now.file.size) break;

        const end = Math.min(now.offset + CHUNK, now.file.size);
        const slice = now.file.slice(now.offset, end);
        const base_ = now.offset;

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
        patch(key, { offset: body.upload?.offset ?? end, xhr: null });

        // Re-baseline the rate occasionally so it tracks the current connection.
        if (Date.now() - startedAt > 10_000) {
          startedAt = Date.now();
          startedFrom = body.upload?.offset ?? end;
        }
      }

      patch(key, { phase: 'importing', bytesPerSecond: 0 });
      const finished = await api(`${base}/uploads/${items.current.find((e) => e.key === key)?.id}/finish`, {
        method: 'POST',
      });
      patch(key, {
        phase: 'done',
        offset: finished.upload?.offset ?? 0,
        name: finished.upload?.fileName ?? item.name,
      });

      // Everything settled: bring the page's own video list up to date.
      if (items.current.every((entry) => entry.phase === 'done' || entry.phase === 'canceled')) {
        window.setTimeout(() => window.location.reload(), 1200);
      }
    } catch (error) {
      // A canceled request is a user action, not a failure to report.
      const now = items.current.find((entry) => entry.key === key);
      if (now?.phase === 'paused' || now?.phase === 'canceled') return;
      fail(key, error);
    }
  };

  const add = (files: FileList | File[]): void => {
    for (const file of Array.from(files)) {
      const key = `${file.name}:${file.size}:${Math.random().toString(36).slice(2)}`;
      items.current.push({
        key,
        file,
        name: file.name,
        id: null,
        offset: 0,
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

              {item.phase === 'uploading' ? (
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
              <p class="pill reject upload-error">
                {item.error}
                {item.hint === null ? '' : ` ${item.hint}`}
                {item.id === null ? '' : ` — ${item.code}, upload ${item.id}`}
              </p>
            )}
          </div>
        );
      })}
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
