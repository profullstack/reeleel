import { serve } from '@hono/node-server';

import { createApp } from './app.js';

const port = Number(process.env['PORT'] ?? 8787);
// Loopback by default: this API can read and delete local project directories,
// so binding it to every interface has to be a deliberate act.
const hostname = process.env['HOST'] ?? '127.0.0.1';

serve({ fetch: createApp().fetch, port, hostname }, (info) => {
  process.stdout.write(`ReelEel API listening on http://${hostname}:${info.port}\n`);
});
