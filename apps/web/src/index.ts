import { serve } from '@hono/node-server';

import { AuthConfigError, assertAuthConfigured, isAuthEnabled } from '@reeleel/api';

import { clientBundleExists, createWebApp } from './server.js';

const port = Number(process.env['PORT'] ?? 8788);
// Loopback by default — this app can read local project directories.
const hostname = process.env['HOST'] ?? '127.0.0.1';

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

serve({ fetch: createWebApp().fetch, port, hostname }, (info) => {
  const mode = isAuthEnabled() ? 'token auth enabled' : 'no auth (loopback only)';
  process.stdout.write(`ReelEel web listening on http://${hostname}:${info.port} — ${mode}\n`);
});
