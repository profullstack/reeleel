/** @jsxImportSource hono/jsx */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';

import { createApp as createApiApp } from '@reeleel/api';
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

import { DoctorPage, ErrorPage, ProjectsPage } from './views/pages.js';
import { ProjectPage } from './views/pages.js';

const publicDir = path.join(fileURLToPath(new URL('../', import.meta.url)), 'public');

/**
 * One process serves both halves: SSR pages for readability and the API for the
 * client island. Splitting them across ports is a deployment choice, not an
 * architectural one — `@reeleel/api` is its own package either way.
 */
export const createWebApp = (): Hono => {
  const app = new Hono();

  app.route('/', createApiApp());

  app.use(
    '/client.js',
    serveStatic({ root: path.relative(process.cwd(), publicDir) || '.', rewriteRequestPath: () => '/client.js' }),
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
      const root = await resolveProjectRoot(decodeURIComponent(c.req.param('ref')));
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
