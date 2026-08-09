/** @jsxImportSource hono/jsx */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';

import {
  clientKey,
  createApp as createApiApp,
  endSession,
  isAuthEnabled,
  loginAttemptAllowed,
  readAuthConfig,
  requireAuth,
  resetLoginAttempts,
  safeEqual,
  startSession,
} from '@reeleel/api';
import {
  isReelEelError,
  listMoments,
  listProjects,
  listVideos,
  resolveProjectRoot,
  runChecks,
  summarizeProject,
  worstStatus,
} from '@reeleel/core';

import { DoctorPage, ErrorPage, LoginPage, ProjectPage, ProjectsPage } from './views/pages.js';

const publicDir = path.join(fileURLToPath(new URL('../', import.meta.url)), 'public');

/**
 * Only same-origin relative paths are accepted as a post-login destination.
 * Anything else — including protocol-relative `//evil.example` — falls back to
 * the home page, so the login form cannot be used as an open redirect.
 */
export const safeRedirect = (value: unknown): string => {
  if (typeof value !== 'string' || value.length === 0) return '/';
  if (!value.startsWith('/') || value.startsWith('//')) return '/';
  return value;
};

/**
 * One process serves both halves: SSR pages for readability and the API for the
 * client island. Splitting them across ports is a deployment choice, not an
 * architectural one — `@reeleel/api` is its own package either way.
 */
export const createWebApp = (): Hono => {
  const app = new Hono();
  const auth = readAuthConfig();

  app.route('/', createApiApp({ auth }));

  app.use(
    '/client.js',
    serveStatic({
      root: path.relative(process.cwd(), publicDir) || '.',
      rewriteRequestPath: () => '/client.js',
    }),
  );

  app.get('/login', (c) => {
    if (!isAuthEnabled(auth)) return c.redirect('/');
    return c.html(<LoginPage next={safeRedirect(c.req.query('next'))} />);
  });

  app.post('/login', async (c) => {
    if (!isAuthEnabled(auth) || auth.token === null) return c.redirect('/');

    const body = await c.req.parseBody();
    const next = safeRedirect(body['next']);

    if (!loginAttemptAllowed(clientKey(c))) {
      return c.html(
        <LoginPage error="Too many attempts. Wait a few minutes and try again." next={next} />,
        429,
      );
    }

    const presented = body['token'];
    if (typeof presented !== 'string' || !safeEqual(presented, auth.token)) {
      // Deliberately vague: there is one secret, so "which part was wrong" is
      // not a useful distinction to leak.
      return c.html(<LoginPage error="That token is not valid." next={next} />, 401);
    }

    resetLoginAttempts(clientKey(c));
    startSession(c, auth);
    return c.redirect(next);
  });

  app.get('/logout', (c) => {
    endSession(c);
    return c.redirect(isAuthEnabled(auth) ? '/login' : '/');
  });

  // Pages redirect to the login form rather than returning a bare 401, so a
  // browser lands somewhere useful. The API keeps its JSON 401.
  app.use(
    '*',
    requireAuth({
      config: auth,
      onUnauthorized: (c) => {
        const url = new URL(c.req.url);
        const next = encodeURIComponent(`${url.pathname}${url.search}`);
        return c.redirect(`/login?next=${next}`);
      },
    }),
  );

  app.get('/', async (c) => {
    try {
      return c.html(<ProjectsPage projects={await listProjects()} />);
    } catch (error) {
      return c.html(<ErrorPage message={String(error)} />, 500);
    }
  });

  app.get('/doctor', async (c) => {
    const checks = await runChecks();
    return c.html(<DoctorPage checks={checks} status={worstStatus(checks)} />);
  });

  app.get('/projects/:ref', async (c) => {
    try {
      const ref = c.req.param('ref');
      if (ref === undefined) return c.html(<ErrorPage message="No project given." />, 400);

      const root = await resolveProjectRoot(decodeURIComponent(ref));
      const [project, videos, moments] = await Promise.all([
        summarizeProject(root),
        listVideos(root),
        listMoments(root),
      ]);
      return c.html(<ProjectPage project={project} videos={videos} moments={moments} />);
    } catch (error) {
      if (isReelEelError(error)) {
        return c.html(<ErrorPage message={error.message} hint={error.hint} />, 404);
      }
      return c.html(<ErrorPage message={String(error)} />, 500);
    }
  });

  app.notFound((c) => c.html(<ErrorPage message="No such page." />, 404));

  return app;
};

export const clientBundleExists = (): boolean => existsSync(path.join(publicDir, 'client.js'));
