/**
 * Progressive enhancement for the import form.
 *
 * Without JavaScript the form posts normally and the server still streams it to
 * disk — the fix for large uploads does not depend on any of this. What this
 * adds is the thing a plain form post cannot do: tell the user what is
 * happening, and tell them what went wrong when it doesn't.
 *
 * The case worth understanding is a connection that dies mid-upload. There is
 * no response then, so `xhr.onerror` fires with nothing in it — the browser
 * genuinely does not know why. That is why the upload is named client-side
 * before it starts: the id survives the dead request, and the server's own
 * record of the failure can be fetched afterwards and shown.
 */

interface UploadResponse {
  ok: boolean;
  message?: string;
  code?: string;
  error?: string;
  hint?: string;
  uploadId?: string | null;
}

interface UploadRecord {
  status: string;
  bytesReceived: number;
  bytesExpected: number | null;
  code: string | null;
  error: string | null;
  hint: string | null;
}

const newUploadId = (): string => {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return `up_${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
};

const size = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} kB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
};

const clock = (seconds: number): string => {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  const total = Math.round(seconds);
  const minutes = Math.floor(total / 60);
  return minutes > 0 ? `${minutes}m ${String(total % 60).padStart(2, '0')}s` : `${total}s`;
};

/** Builds the progress UI once, on first use, so no-JS pages stay untouched. */
const buildPanel = (form: HTMLFormElement): {
  panel: HTMLElement;
  bar: HTMLProgressElement;
  detail: HTMLElement;
  message: HTMLElement;
  cancel: HTMLButtonElement;
} => {
  const panel = document.createElement('div');
  panel.className = 'card';
  panel.hidden = true;

  const bar = document.createElement('progress');
  bar.max = 1;
  bar.value = 0;
  bar.style.width = '100%';

  const detail = document.createElement('p');
  detail.className = 'muted';

  const message = document.createElement('p');

  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.textContent = 'Cancel';

  panel.append(bar, detail, message, cancel);
  form.append(panel);
  return { panel, bar, detail, message, cancel };
};

/** Asks the server what it recorded, for when the response never arrived. */
const recoverOutcome = async (uploadId: string): Promise<UploadRecord | null> => {
  try {
    const response = await fetch(`/uploads/${encodeURIComponent(uploadId)}`, {
      headers: { accept: 'application/json' },
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as { ok: boolean; upload?: UploadRecord };
    return payload.ok && payload.upload !== undefined ? payload.upload : null;
  } catch {
    return null;
  }
};

const enhance = (form: HTMLFormElement): void => {
  const input = form.querySelector<HTMLInputElement>('input[type="file"]');
  if (input === null) return;

  const ui = buildPanel(form);
  let live: XMLHttpRequest | null = null;

  ui.cancel.addEventListener('click', () => {
    live?.abort();
  });

  form.addEventListener('submit', (event) => {
    const file = input.files?.[0];
    // No file chosen means the server-path field is in play: nothing to stream,
    // so let the browser post the form the ordinary way.
    if (file === undefined) return;

    event.preventDefault();

    const uploadId = newUploadId();
    const started = Date.now();
    const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]');

    ui.panel.hidden = false;
    ui.message.textContent = '';
    ui.message.className = '';
    ui.bar.removeAttribute('value');
    ui.detail.textContent = `Starting ${file.name} (${size(file.size)})…`;
    if (submit !== null) submit.disabled = true;

    const settle = (): void => {
      live = null;
      ui.cancel.hidden = true;
      if (submit !== null) submit.disabled = false;
    };

    const fail = (code: string, text: string, hint?: string | null): void => {
      ui.bar.hidden = true;
      ui.message.className = 'pill reject';
      ui.message.textContent =
        `${text}${hint === null || hint === undefined ? '' : ` ${hint}`}` +
        ` — ${code}, upload ${uploadId}`;
      ui.detail.textContent = 'Nothing was imported. You can try again.';
      settle();
    };

    const xhr = new XMLHttpRequest();
    live = xhr;
    ui.cancel.hidden = false;

    xhr.open('POST', form.action);
    xhr.setRequestHeader('accept', 'application/json');
    xhr.setRequestHeader('x-upload-id', uploadId);

    xhr.upload.addEventListener('progress', (progress) => {
      if (!progress.lengthComputable) return;
      const fraction = progress.loaded / progress.total;
      ui.bar.value = fraction;
      const elapsed = (Date.now() - started) / 1000;
      const rate = elapsed > 0 ? progress.loaded / elapsed : 0;
      const remaining = rate > 0 ? (progress.total - progress.loaded) / rate : Number.NaN;
      ui.detail.textContent =
        `${Math.floor(fraction * 100)}% — ${size(progress.loaded)} of ${size(progress.total)}` +
        ` at ${size(rate)}/s, ${clock(remaining)} left`;
    });

    // The whole file is on the wire; the server is now probing and importing it.
    xhr.upload.addEventListener('load', () => {
      ui.bar.removeAttribute('value');
      ui.detail.textContent = 'Uploaded. Importing…';
      ui.cancel.hidden = true;
    });

    xhr.addEventListener('load', () => {
      let payload: UploadResponse | null = null;
      try {
        payload = JSON.parse(xhr.responseText) as UploadResponse;
      } catch {
        payload = null;
      }

      if (xhr.status >= 200 && xhr.status < 300 && payload?.ok === true) {
        // Reload so the new video appears in the server-rendered list.
        const target = new URL(window.location.href);
        target.searchParams.delete('err');
        target.searchParams.set('ok', payload.message ?? 'Footage imported');
        window.location.assign(target.toString());
        return;
      }

      fail(
        payload?.code ?? `HTTP_${xhr.status}`,
        payload?.error ?? `The server rejected the upload (${xhr.status}).`,
        payload?.hint,
      );
    });

    // No response at all: the connection dropped, or a proxy cut it off. The
    // browser cannot say why — but the server may have recorded a reason.
    xhr.addEventListener('error', () => {
      ui.detail.textContent = 'The connection dropped. Checking what the server recorded…';
      void recoverOutcome(uploadId).then((record) => {
        if (record !== null && record.code !== null) {
          fail(record.code, record.error ?? 'The upload failed.', record.hint);
          return;
        }
        const seen = record === null ? null : size(record.bytesReceived);
        fail(
          'UPLOAD_ABORTED',
          'The connection to the server dropped mid-upload.',
          seen === null
            ? 'The server has no record of it — check that it is still running.'
            : `The server received ${seen} before the connection ended.`,
        );
      });
    });

    xhr.addEventListener('timeout', () => {
      fail('UPLOAD_TIMEOUT', 'The upload timed out.', 'Check the connection and try again.');
    });

    xhr.addEventListener('abort', () => {
      ui.bar.hidden = true;
      ui.message.className = 'pill';
      ui.message.textContent = `Upload canceled — ${uploadId}`;
      ui.detail.textContent = 'Nothing was imported.';
      settle();
    });

    xhr.send(new FormData(form));
  });
};

export const mountUploads = (): void => {
  // `crypto.getRandomValues` and XHR upload progress are both required; without
  // them the plain form post is still correct, so bail out quietly.
  if (typeof XMLHttpRequest === 'undefined' || typeof crypto?.getRandomValues !== 'function') return;
  for (const form of Array.from(
    document.querySelectorAll<HTMLFormElement>('form[data-upload]'),
  )) {
    enhance(form);
  }
};
