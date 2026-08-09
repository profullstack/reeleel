import { serve } from '@hono/node-server';

import { AuthConfigError, assertAuthConfigured, isAuthEnabled } from '@reeleel/api';

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
