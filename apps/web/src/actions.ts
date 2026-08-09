import { existsSync, mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { Context, Hono } from 'hono';

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
  projectDir,
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

/** Filenames arrive from a browser and must never escape the project. */
const safeFileName = (name: string): string => path.basename(name).replace(/[^A-Za-z0-9._-]/g, '_');

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

  app.post('/projects/:ref/videos', async (c) => {
    const bad = await guard(c);
    if (bad !== null) return bad;
    const ref = c.req.param('ref') ?? '';
    const to = `/projects/${encodeURIComponent(ref)}`;

    try {
      const root = await rootOf(c);
      const body = await c.req.parseBody();

      const upload = body['file'];
      if (upload instanceof File && upload.size > 0) {
        // Uploaded footage has nowhere else to live, so it is written into the
        // project's own source/ directory and referenced from there.
        const dir = projectDir(root, 'source');
        mkdirSync(dir, { recursive: true });
        const target = path.join(dir, safeFileName(upload.name));
        if (existsSync(target)) return back(c, to, undefined, 'A file with that name is already imported.');

        await writeFile(target, Buffer.from(await upload.arrayBuffer()));
        await addVideo(root, target);
        return back(c, to, 'Footage imported');
      }

      const filePath = field(body, 'path');
      if (filePath.length === 0) return back(c, to, undefined, 'Choose a file or give a path.');

      await addVideo(root, filePath, { copy: field(body, 'copy') === 'on' });
      return back(c, to, 'Footage imported');
    } catch (error) {
      return back(c, to, undefined, failed(error));
    }
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
