import { Hono } from 'hono';
import type { Context } from 'hono';
import { cors } from 'hono/cors';

import {
  addAthlete,
  addMoment,
  clipsFromMoments,
  createProject,
  createReel,
  listAthletes,
  listClips,
  listJobs,
  listModels,
  listMoments,
  listProjects,
  listReels,
  listSports,
  listVideos,
  ReelEelError,
  removeAthlete,
  removeMoment,
  removeProject,
  resolveProjectRoot,
  runChecks,
  summarizeProject,
  updateAthlete,
  updateMoment,
  updateProject,
  worstStatus,
} from '@reeleel/core';

import { readAuthConfig, requireAuth } from './auth.js';
import type { AuthConfig } from './auth.js';
import { errorResponse, handle } from './errors.js';

// The web app shares this auth implementation rather than reimplementing it.
export * from './auth.js';

/**
 * The API is a thin shell over @reeleel/core — deliberately. Any logic that
 * lands here instead of in core is logic the CLI and desktop app silently do
 * not get, which is exactly the drift the PRD's "GUI and CLI use the same
 * underlying services" requirement is meant to prevent.
 *
 * Note there is no upload endpoint: footage is referenced from the local
 * filesystem and never posted anywhere.
 */
export interface CreateAppOptions {
  /** Injectable for tests; defaults to reading the environment. */
  auth?: AuthConfig;
}

export const createApp = (options: CreateAppOptions = {}): Hono => {
  const app = new Hono();
  const auth = options.auth ?? readAuthConfig();

  // The web app is same-origin in production; CORS is for local split-port dev.
  // Credentials are never reflected, so a cookie cannot be replayed cross-origin.
  app.use('/api/*', cors({ origin: (origin) => origin ?? '*' }));

  // Scoped to /api/* rather than '*' so that when the web app mounts this, a
  // page request falls through to the web app's own guard and gets redirected
  // to the login form instead of a JSON 401. Public paths (/api/health) are
  // still exempted inside the middleware.
  app.use('/api/*', requireAuth({ config: auth }));

  app.get('/api/health', (c) => c.json({ ok: true, service: 'reeleel-api', version: '0.1.0' }));

  app.get(
    '/api/doctor',
    handle(async () => {
      const checks = await runChecks();
      return { status: worstStatus(checks), checks };
    }),
  );

  app.get(
    '/api/sports',
    handle(async () => ({ sports: listSports() })),
  );

  app.get(
    '/api/models',
    handle(async () => ({ models: await listModels() })),
  );

  app.get(
    '/api/projects',
    handle(async () => ({ projects: await listProjects() })),
  );

  app.post(
    '/api/projects',
    handle(async (c) => {
      const body = (await c.req.json()) as {
        name?: string;
        sport?: string;
        path?: string;
        opponent?: string;
        gameDate?: string;
      };
      if (typeof body.name !== 'string' || body.name.trim().length === 0) {
        throw new Error('A project name is required.');
      }
      const created = await createProject({
        name: body.name,
        ...(body.sport === undefined ? {} : { sport: body.sport }),
        ...(body.path === undefined ? {} : { path: body.path }),
        ...(body.opponent === undefined ? {} : { opponent: body.opponent }),
        ...(body.gameDate === undefined ? {} : { gameDate: body.gameDate }),
      });
      return { project: created.manifest, root: created.root };
    }),
  );

  /**
   * Hono types route params as possibly-undefined on an unparameterised
   * Context. A matched route always has them, so treat a missing one as a bug
   * rather than threading optionality through every handler.
   */
  const param = (c: Context, name: string): string => {
    const value = c.req.param(name);
    if (value === undefined) throw new ReelEelError('INVALID_INPUT', `Missing :${name} in path.`);
    return value;
  };

  /** Project references are opaque strings (path, id or name) and must be encoded. */
  const rootOf = async (c: Context): Promise<string> =>
    resolveProjectRoot(decodeURIComponent(param(c, 'ref')));

  app.get(
    '/api/projects/:ref',
    handle(async (c) => ({ project: await summarizeProject(await rootOf(c)) })),
  );

  app.patch(
    '/api/projects/:ref',
    handle(async (c) => {
      const root = await rootOf(c);
      const body = (await c.req.json()) as Record<string, string | null>;
      const project = await updateProject(root, body);
      return { project };
    }),
  );

  app.delete(
    '/api/projects/:ref',
    handle(async (c) => {
      const root = await rootOf(c);
      // Deleting files over HTTP requires an explicit opt-in, never a default.
      const deleteFiles = c.req.query('deleteFiles') === 'true';
      return { result: await removeProject(root, { deleteFiles }) };
    }),
  );

  app.get(
    '/api/projects/:ref/videos',
    handle(async (c) => ({ videos: await listVideos(await rootOf(c)) })),
  );

  app.get(
    '/api/projects/:ref/athletes',
    handle(async (c) => ({ athletes: await listAthletes(await rootOf(c)) })),
  );

  app.post(
    '/api/projects/:ref/athletes',
    handle(async (c) => {
      const root = await rootOf(c);
      const body = (await c.req.json()) as Parameters<typeof addAthlete>[1];
      return { athlete: await addAthlete(root, body) };
    }),
  );

  app.patch(
    '/api/projects/:ref/athletes/:id',
    handle(async (c) => {
      const root = await rootOf(c);
      const body = (await c.req.json()) as Parameters<typeof updateAthlete>[2];
      return { athlete: await updateAthlete(root, param(c, 'id'), body) };
    }),
  );

  app.delete(
    '/api/projects/:ref/athletes/:id',
    handle(async (c) => {
      const root = await rootOf(c);
      return { athlete: await removeAthlete(root, param(c, 'id')) };
    }),
  );

  app.get(
    '/api/projects/:ref/moments',
    handle(async (c) => {
      const root = await rootOf(c);
      const included = c.req.query('included');
      return {
        moments: await listMoments(root, {
          ...(included === undefined ? {} : { included: included === 'true' }),
        }),
      };
    }),
  );

  app.post(
    '/api/projects/:ref/moments',
    handle(async (c) => {
      const root = await rootOf(c);
      const body = (await c.req.json()) as Parameters<typeof addMoment>[1];
      return { moment: await addMoment(root, { ...body, manual: true }) };
    }),
  );

  app.patch(
    '/api/projects/:ref/moments/:id',
    handle(async (c) => {
      const root = await rootOf(c);
      const body = (await c.req.json()) as Parameters<typeof updateMoment>[2];
      return { moment: await updateMoment(root, param(c, 'id'), body) };
    }),
  );

  app.delete(
    '/api/projects/:ref/moments/:id',
    handle(async (c) => {
      const root = await rootOf(c);
      return { moment: await removeMoment(root, param(c, 'id')) };
    }),
  );

  app.get(
    '/api/projects/:ref/clips',
    handle(async (c) => ({ clips: await listClips(await rootOf(c)) })),
  );

  app.post(
    '/api/projects/:ref/clips/from-moments',
    handle(async (c) => {
      const root = await rootOf(c);
      return { clips: await clipsFromMoments(root) };
    }),
  );

  app.get(
    '/api/projects/:ref/reels',
    handle(async (c) => ({ reels: await listReels(await rootOf(c)) })),
  );

  app.post(
    '/api/projects/:ref/reels',
    handle(async (c) => {
      const root = await rootOf(c);
      const body = (await c.req.json()) as Parameters<typeof createReel>[1];
      return { reel: await createReel(root, body) };
    }),
  );

  app.get(
    '/api/projects/:ref/jobs',
    handle(async (c) => ({ jobs: await listJobs(await rootOf(c)) })),
  );

  app.notFound((c) => c.json({ ok: false, code: 'NOT_FOUND', error: 'No such endpoint.' }, 404));
  app.onError((error, c) => errorResponse(c, error));

  return app;
};
