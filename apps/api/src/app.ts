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

import {
  ownerFor,
  requireVerifiedEmail,
  resolveUserFromRequest,
  scopeFor,
} from './accounts.js';
import {
  clientKey,
  currentUser,
  loginAttemptAllowed,
  readAuthConfig,
  requireAuth,
  resetLoginAttempts,
} from './auth.js';
import type { AuthConfig } from './auth.js';
import { createUserSession, verifyLogin } from './users.js';
import { errorResponse, handle } from './errors.js';

// The web app shares this implementation rather than reimplementing it.
export * from './auth.js';
export * from './accounts.js';
export * from './email.js';
export * from './passwords.js';
export * from './users.js';

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
  app.use(
    '/api/*',
    requireAuth({
      config: auth,
      resolveUser: resolveUserFromRequest,
      requireVerifiedEmail: requireVerifiedEmail(),
    }),
  );

  app.get('/api/health', (c) => c.json({ ok: true, service: 'reeleel-api', version: '0.2.0' }));

  /**
   * Token login for native clients, which have no cookie jar. Returns the same
   * session secret the browser stores in a cookie, so revocation and expiry
   * behave identically across surfaces.
   */
  app.post('/api/login', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { email?: string; password?: string };
    if (typeof body.email !== 'string' || typeof body.password !== 'string') {
      return c.json({ ok: false, code: 'INVALID_INPUT', error: 'Email and password are required.' }, 400);
    }
    if (!loginAttemptAllowed(`api:${clientKey(c)}`)) {
      return c.json({ ok: false, code: 'RATE_LIMITED', error: 'Too many attempts.' }, 429);
    }

    const user = await verifyLogin(body.email, body.password);
    if (user === null) {
      // Same message for both failure modes, as on the web form.
      return c.json({ ok: false, code: 'UNAUTHORIZED', error: 'Those details do not match an account.' }, 401);
    }

    resetLoginAttempts(`api:${clientKey(c)}`);
    return c.json({
      ok: true,
      token: await createUserSession(user.id),
      user: { id: user.id, email: user.email, emailVerified: user.emailVerifiedAt !== null },
    });
  });

  app.get('/api/me', (c) => {
    const user = currentUser(c);
    return c.json({
      ok: true,
      user:
        user === null
          ? null
          : { id: user.id, email: user.email, emailVerified: user.emailVerifiedAt !== null },
    });
  });

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
    handle(async (c) => ({ projects: await listProjects(scopeFor(c)) })),
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
      const owner = ownerFor(c);
      const created = await createProject({
        name: body.name,
        ...(body.sport === undefined ? {} : { sport: body.sport }),
        ...(body.path === undefined ? {} : { path: body.path }),
        ...(body.opponent === undefined ? {} : { opponent: body.opponent }),
        ...(body.gameDate === undefined ? {} : { gameDate: body.gameDate }),
        ...(owner === undefined ? {} : { ownerId: owner }),
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

  /**
   * Project references are opaque strings (path, id or name) and must be
   * encoded. The scope is what stops one account reaching another's project —
   * including by passing a raw filesystem path.
   */
  const rootOf = async (c: Context): Promise<string> =>
    resolveProjectRoot(decodeURIComponent(param(c, 'ref')), scopeFor(c));

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
