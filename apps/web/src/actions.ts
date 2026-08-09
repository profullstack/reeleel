import { existsSync } from 'node:fs';
import { unlink } from 'node:fs/promises';

import type { Context, Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

import { originAllowed, ownerFor, scopeFor } from '@reeleel/api';
import {
  addAthlete,
  addVideo,
  analyzeProject,
  clipsFromMoments,
  createProject,
  createReel,
  isReelEelError,
  loadConfig,
  removeAthlete,
  removeProject,
  removeVideo,
  renderReel,
  resolveProjectRoot,
  updateAthlete,
  updateMoment,
  updateProject,
} from '@reeleel/core';
import type { AspectRatio, Preset } from '@reeleel/core';

import { boundaryOf } from './multipart.js';
import { UploadError, receiveVideoUpload } from './receive.js';
import { beginUpload, failUpload, finishUpload, getUploadFor, importingUpload } from './uploads.js';
import type { UploadRecord } from './uploads.js';

/**
 * Every mutation the UI can perform.
 *
 * These are plain form posts that redirect, not JSON endpoints: the pages are
 * server-rendered and must keep working without JavaScript. The JSON API in
 * @reeleel/api stays the machine-facing surface.
 */

const field = (body: Record<string, unknown>, name: string): string => {
  const value = body[name];
  return typeof value === 'string' ? value.trim() : '';
};

const optional = (body: Record<string, unknown>, name: string): string | undefined => {
  const value = field(body, name);
  return value.length > 0 ? value : undefined;
};

/** Carries a short message back to the redirected-to page. */
const back = (c: Context, to: string, message?: string, error?: string): Response => {
  const params = new URLSearchParams();
  if (message !== undefined) params.set('ok', message);
  if (error !== undefined) params.set('err', error);
  const query = params.toString();
  return c.redirect(query.length > 0 ? `${to}?${query}` : to);
};

const failed = (error: unknown): string =>
  isReelEelError(error) ? `${error.message}${error.hint === undefined ? '' : ` ${error.hint}`}` : String(error);

/**
 * A failure reduced to the parts every surface needs: a stable code to key off,
 * a sentence to show, a hint, and a status. Silence is not one of the options.
 */
interface Described {
  code: string;
  error: string;
  hint: string | undefined;
  status: ContentfulStatusCode;
}

const describe = (error: unknown): Described => {
  if (error instanceof UploadError) {
    return {
      code: error.code,
      error: error.message,
      hint: error.hint,
      status: error.status as ContentfulStatusCode,
    };
  }
  if (isReelEelError(error)) {
    return { code: error.code, error: error.message, hint: error.hint, status: 400 };
  }
  return {
    code: 'UNKNOWN',
    error: error instanceof Error ? error.message : String(error),
    hint: undefined,
    status: 500,
  };
};

/**
 * The enhanced uploader asks for JSON so it can show a real error; the plain
 * form gets the redirect it has always got. Both carry the same upload id.
 */
const prefersJson = (c: Context): boolean =>
  (c.req.header('accept') ?? '').includes('application/json');

const uploadOk = (
  c: Context,
  to: string,
  message: string,
  record: UploadRecord | null,
): Response => {
  if (record !== null) c.header('x-upload-id', record.id);
  return prefersJson(c)
    ? c.json({ ok: true, message, uploadId: record?.id ?? null })
    : back(c, to, message);
};

const uploadFailed = (
  c: Context,
  to: string,
  record: UploadRecord | null,
  error: unknown,
): Response => {
  const described = describe(error);
  if (record !== null) {
    c.header('x-upload-id', record.id);
    failUpload(record, { ...described, hint: described.hint, cause: error });
  } else {
    process.stderr.write(`[upload -] failed ${described.code}: ${described.error}\n`);
  }
  if (prefersJson(c)) {
    return c.json(
      { ok: false, code: described.code, error: described.error, hint: described.hint, uploadId: record?.id ?? null },
      described.status,
    );
  }
  // The id goes in the flash so a user can quote it and an operator can grep it.
  const suffix = record === null ? '' : ` (upload ${record.id})`;
  const hint = described.hint === undefined ? '' : ` ${described.hint}`;
  return back(c, to, undefined, `${described.error}${hint}${suffix}`);
};

export const registerActions = (app: Hono): void => {
  const guard = async (c: Context): Promise<Response | null> =>
    originAllowed(c) ? null : c.text('Bad origin', 403);

  const rootOf = async (c: Context): Promise<string> => {
    const ref = c.req.param('ref');
    if (ref === undefined) throw new Error('No project given.');
    return resolveProjectRoot(decodeURIComponent(ref), scopeFor(c));
  };

  // ── Projects ──────────────────────────────────────────────────────────────

  app.post('/projects', async (c) => {
    const bad = await guard(c);
    if (bad !== null) return bad;

    const body = await c.req.parseBody();
    const name = field(body, 'name');
    if (name.length === 0) return back(c, '/', undefined, 'A project needs a name.');

    try {
      const owner = ownerFor(c);
      const created = await createProject({
        name,
        sport: field(body, 'sport') || 'soccer',
        ...(optional(body, 'opponent') === undefined ? {} : { opponent: optional(body, 'opponent') as string }),
        ...(optional(body, 'gameDate') === undefined ? {} : { gameDate: optional(body, 'gameDate') as string }),
        ...(owner === undefined ? {} : { ownerId: owner }),
      });
      return c.redirect(`/projects/${encodeURIComponent(created.manifest.id)}?ok=Project+created`);
    } catch (error) {
      return back(c, '/', undefined, failed(error));
    }
  });

  app.post('/projects/:ref/update', async (c) => {
    const bad = await guard(c);
    if (bad !== null) return bad;
    const ref = c.req.param('ref') ?? '';

    try {
      const root = await rootOf(c);
      const body = await c.req.parseBody();
      // An empty field clears the value, matching the CLI's convention.
      await updateProject(root, {
        ...(field(body, 'name').length > 0 ? { name: field(body, 'name') } : {}),
        opponent: field(body, 'opponent').length > 0 ? field(body, 'opponent') : null,
        gameDate: field(body, 'gameDate').length > 0 ? field(body, 'gameDate') : null,
        description: field(body, 'description').length > 0 ? field(body, 'description') : null,
      });
      return back(c, `/projects/${encodeURIComponent(ref)}`, 'Saved');
    } catch (error) {
      return back(c, `/projects/${encodeURIComponent(ref)}`, undefined, failed(error));
    }
  });

  app.post('/projects/:ref/delete', async (c) => {
    const bad = await guard(c);
    if (bad !== null) return bad;

    try {
      const root = await rootOf(c);
      const body = await c.req.parseBody();
      // Deleting footage is irreversible, so the destructive variant needs an
      // explicit checkbox rather than being the default.
      await removeProject(root, { deleteFiles: field(body, 'deleteFiles') === 'on' });
      return back(c, '/', 'Project removed');
    } catch (error) {
      return back(c, '/', undefined, failed(error));
    }
  });

  // ── Videos ────────────────────────────────────────────────────────────────

  /**
   * Import footage — by upload, or by a path already on the server.
   *
   * The upload is streamed to disk rather than parsed into memory: see
   * receive.ts for why that distinction is the whole bug this route used to
   * have. Every attempt is tracked from before its first byte, so a failure at
   * any point has an id, a code and a log line instead of a dead progress bar.
   */
  app.post('/projects/:ref/videos', async (c) => {
    const bad = await guard(c);
    if (bad !== null) return bad;
    const ref = c.req.param('ref') ?? '';
    const to = `/projects/${encodeURIComponent(ref)}`;

    let record: UploadRecord | null = null;
    try {
      const root = await rootOf(c);

      // A plain (non-multipart) post can only be the server-path form; it has
      // no body worth streaming, so the simple path stays simple.
      if (boundaryOf(c.req.header('content-type')) === null) {
        const body = await c.req.parseBody();
        const filePath = field(body, 'path');
        if (filePath.length === 0) {
          return uploadFailed(c, to, null, new UploadError('NO_FILE', 'Choose a file or give a path.'));
        }
        await addVideo(root, filePath, { copy: field(body, 'copy') === 'on' });
        return uploadOk(c, to, 'Footage imported', null);
      }

      const declared = Number(c.req.header('content-length'));
      record = beginUpload({
        projectRef: ref,
        ownerId: ownerFor(c),
        bytesExpected: Number.isFinite(declared) && declared > 0 ? declared : null,
        // The browser names the upload up front so that if the connection dies
        // before any response, it still knows what to ask /uploads/:id about.
        id: c.req.header('x-upload-id'),
      });

      const received = await receiveVideoUpload(c, {
        root,
        record,
        exists: (target) => existsSync(target),
      });

      if (received.savedPath !== null) {
        importingUpload(record);
        try {
          await addVideo(root, received.savedPath);
        } catch (error) {
          // The copy in source/ is ours alone; a rejected import must not leave
          // it behind to collide with the user's next attempt.
          await unlink(received.savedPath).catch(() => undefined);
          throw error;
        }
        finishUpload(record);
        return uploadOk(c, to, 'Footage imported', record);
      }

      // No file part — the user filled in the server-path field instead.
      const filePath = (received.fields['path'] ?? '').trim();
      if (filePath.length === 0) {
        return uploadFailed(c, to, record, new UploadError('NO_FILE', 'Choose a file or give a path.'));
      }
      await addVideo(root, filePath, { copy: received.fields['copy'] === 'on' });
      finishUpload(record);
      return uploadOk(c, to, 'Footage imported', record);
    } catch (error) {
      return uploadFailed(c, to, record, error);
    }
  });

  /**
   * The progress and outcome of one upload. The enhanced uploader polls this
   * when a connection drops mid-post, which is the case where the browser
   * itself can tell the user nothing at all.
   */
  app.get('/uploads/:id', (c) => {
    const record = getUploadFor(c.req.param('id') ?? '', ownerFor(c));
    if (record === undefined) {
      return c.json({ ok: false, code: 'NOT_FOUND', error: 'No such upload.' }, 404);
    }
    return c.json({ ok: true, upload: record });
  });

  app.post('/projects/:ref/videos/:id/delete', async (c) => {
    const bad = await guard(c);
    if (bad !== null) return bad;
    const ref = c.req.param('ref') ?? '';
    const to = `/projects/${encodeURIComponent(ref)}`;

    try {
      const root = await rootOf(c);
      await removeVideo(root, c.req.param('id') ?? '');
      return back(c, to, 'Video removed');
    } catch (error) {
      return back(c, to, undefined, failed(error));
    }
  });

  // ── Athletes ──────────────────────────────────────────────────────────────

  app.post('/projects/:ref/athletes', async (c) => {
    const bad = await guard(c);
    if (bad !== null) return bad;
    const ref = c.req.param('ref') ?? '';
    const to = `/projects/${encodeURIComponent(ref)}`;

    try {
      const root = await rootOf(c);
      const body = await c.req.parseBody();
      await addAthlete(root, {
        ...(optional(body, 'name') === undefined ? {} : { name: optional(body, 'name') as string }),
        ...(optional(body, 'number') === undefined ? {} : { jerseyNumber: optional(body, 'number') as string }),
        ...(optional(body, 'team') === undefined ? {} : { team: optional(body, 'team') as string }),
        ...(optional(body, 'color') === undefined ? {} : { jerseyColor: optional(body, 'color') as string }),
        ...(field(body, 'focal') === 'on' ? { focal: true } : {}),
      });
      return back(c, to, 'Athlete added');
    } catch (error) {
      return back(c, to, undefined, failed(error));
    }
  });

  app.post('/projects/:ref/athletes/:id/focus', async (c) => {
    const bad = await guard(c);
    if (bad !== null) return bad;
    const ref = c.req.param('ref') ?? '';
    const to = `/projects/${encodeURIComponent(ref)}`;

    try {
      const root = await rootOf(c);
      await updateAthlete(root, c.req.param('id') ?? '', { focal: true });
      return back(c, to, 'Now following this athlete');
    } catch (error) {
      return back(c, to, undefined, failed(error));
    }
  });

  app.post('/projects/:ref/athletes/:id/delete', async (c) => {
    const bad = await guard(c);
    if (bad !== null) return bad;
    const ref = c.req.param('ref') ?? '';
    const to = `/projects/${encodeURIComponent(ref)}`;

    try {
      const root = await rootOf(c);
      await removeAthlete(root, c.req.param('id') ?? '');
      return back(c, to, 'Athlete removed');
    } catch (error) {
      return back(c, to, undefined, failed(error));
    }
  });

  // ── Analysis and output ───────────────────────────────────────────────────

  app.post('/projects/:ref/analyze', async (c) => {
    const bad = await guard(c);
    if (bad !== null) return bad;
    const ref = c.req.param('ref') ?? '';
    const to = `/projects/${encodeURIComponent(ref)}`;

    try {
      const root = await rootOf(c);
      const body = await c.req.parseBody();
      const preset = (field(body, 'preset') || loadConfig().analysis.preset) as Preset;

      // Analysis takes minutes; holding the request open would time out at the
      // proxy. It records a job, so the page can report progress instead.
      void analyzeProject(root, { preset }).catch((error: unknown) => {
        process.stderr.write(`analysis failed: ${failed(error)}\n`);
      });

      return back(c, to, 'Analysis started — watch the jobs list');
    } catch (error) {
      return back(c, to, undefined, failed(error));
    }
  });

  app.post('/projects/:ref/moments/:id/decide', async (c) => {
    const bad = await guard(c);
    if (bad !== null) return bad;
    const ref = c.req.param('ref') ?? '';
    const to = `/projects/${encodeURIComponent(ref)}`;

    try {
      const root = await rootOf(c);
      const body = await c.req.parseBody();
      const decision = field(body, 'decision');
      await updateMoment(root, c.req.param('id') ?? '', {
        included: decision === 'keep' ? true : decision === 'reject' ? false : null,
      });
      return back(c, to);
    } catch (error) {
      return back(c, to, undefined, failed(error));
    }
  });

  app.post('/projects/:ref/clips', async (c) => {
    const bad = await guard(c);
    if (bad !== null) return bad;
    const ref = c.req.param('ref') ?? '';
    const to = `/projects/${encodeURIComponent(ref)}`;

    try {
      const root = await rootOf(c);
      const created = await clipsFromMoments(root);
      return back(c, to, `${created.length} clip(s) created`);
    } catch (error) {
      return back(c, to, undefined, failed(error));
    }
  });

  app.post('/projects/:ref/export', async (c) => {
    const bad = await guard(c);
    if (bad !== null) return bad;
    const ref = c.req.param('ref') ?? '';
    const to = `/projects/${encodeURIComponent(ref)}`;

    try {
      const root = await rootOf(c);
      const body = await c.req.parseBody();
      const name = field(body, 'name') || 'highlights';
      const aspect = (field(body, 'aspect') || '16:9') as AspectRatio;

      // Create the reel if it does not exist yet, then render in the
      // background for the same reason analysis runs detached.
      try {
        await createReel(root, { name, aspect });
      } catch {
        // Already exists — reuse it.
      }
      void renderReel(root, name, { aspect }).catch((error: unknown) => {
        process.stderr.write(`render failed: ${failed(error)}\n`);
      });

      return back(c, to, 'Rendering started — the file appears under exports when done');
    } catch (error) {
      return back(c, to, undefined, failed(error));
    }
  });
};
