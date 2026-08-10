import { serve } from '@hono/node-server';

import { AuthConfigError, assertAuthConfigured, isAuthEnabled } from '@reeleel/api';
import { failInterruptedJobs, listProjects } from '@reeleel/core';

import { clientBundleExists, createWebApp } from './server.js';

const port = Number(process.env['PORT'] ?? 8788);
// Loopback by default — this app can read local project directories.
const hostname = process.env['HOST'] ?? '127.0.0.1';

/**
 * Node's default `requestTimeout` is 300s, measured from the first byte of the
 * request to the last. That is a sensible ceiling for an API call and a bug for
 * an upload: a 200 MB import on a 700 kB/s connection needs ~290s, so anything
 * slower is destroyed mid-transfer. Node answers a timed-out request by tearing
 * down the socket, which reaches the browser as a bare network error — no
 * status, no body, nothing to log. "It stopped at 70%" is exactly what that
 * looks like.
 *
 * So the ceiling moves out to an hour, and a *stalled* upload is caught by
 * REELEEL_UPLOAD_STALL_SECONDS instead (see receive.ts), which can tell the
 * difference between a slow connection and a dead one and reports which it was.
 */
const requestTimeout = Number(process.env['REELEEL_REQUEST_TIMEOUT_SECONDS'] ?? 3600) * 1000;
// Headers arrive immediately or not at all; keep that guard tight.
const headersTimeout = Number(process.env['REELEEL_HEADERS_TIMEOUT_SECONDS'] ?? 60) * 1000;

// Fail closed: never listen on a public interface without a token.
try {
  assertAuthConfigured(hostname);
} catch (error) {
  if (error instanceof AuthConfigError) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
  throw error;
}

if (!clientBundleExists()) {
  process.stderr.write(
    'Client bundle missing — run `pnpm --filter @reeleel/web exec node scripts/build-client.mjs`.\n' +
      'Pages still render; only the interactive review island will be inert.\n',
  );
}

/**
 * Nothing survives a restart, so nothing should claim to.
 *
 * Analysis runs in this process. A deploy replaces the container mid-run and
 * the job row keeps saying `running` for ever — a detection pass killed at
 * frame 7350 of 9000 is indistinguishable, in the UI, from one still going.
 * This process owns no running work at the moment it starts, so anything the
 * database still calls running was interrupted.
 */
void (async () => {
  try {
    const projects = await listProjects();
    let failed = 0;
    for (const project of projects) {
      // A registered directory that is no longer on disk has no database to open.
      if (!project.exists) continue;
      failed += await failInterruptedJobs(project.root);
    }
    if (failed > 0) {
      process.stderr.write(`marked ${failed} interrupted job(s) as failed after restart\n`);
    }
  } catch (error) {
    // Never block startup on housekeeping.
    process.stderr.write(`job recovery skipped: ${String(error)}\n`);
  }
})();

serve(
  {
    fetch: createWebApp().fetch,
    port,
    hostname,
    serverOptions: { requestTimeout, headersTimeout },
  },
  (info) => {
    const mode = isAuthEnabled() ? 'token auth enabled' : 'no auth (loopback only)';
    process.stdout.write(
      `ReelEel web listening on http://${hostname}:${info.port} — ${mode}, ` +
        `${requestTimeout / 1000}s request timeout\n`,
    );
  },
);
