import { serve } from '@hono/node-server';

import { createApp } from './app.js';
import { AuthConfigError, assertAuthConfigured, isAuthEnabled } from './auth.js';

const port = Number(process.env['PORT'] ?? 8787);
// Loopback by default: this API can read and delete local project directories,
// so binding it to every interface has to be a deliberate act.
const hostname = process.env['HOST'] ?? '127.0.0.1';

try {
  assertAuthConfigured(hostname);
} catch (error) {
  if (error instanceof AuthConfigError) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
  throw error;
}

serve({ fetch: createApp().fetch, port, hostname }, (info) => {
  const mode = isAuthEnabled() ? 'token auth enabled' : 'no auth (loopback only)';
  process.stdout.write(`ReelEel API listening on http://${hostname}:${info.port} — ${mode}\n`);
});
