#!/usr/bin/env node
// Bundles the client-side islands into public/client.js.
//
// hono/jsx/dom is a ~3kB React-compatible runtime, so the SPA half of this app
// needs no framework install and no build config beyond this file.
import { context, build } from 'esbuild';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: [join(root, 'src/client/main.tsx')],
  outfile: join(root, 'public/client.js'),
  bundle: true,
  format: 'esm',
  target: 'es2022',
  minify: process.env.NODE_ENV === 'production',
  sourcemap: true,
  jsx: 'automatic',
  jsxImportSource: 'hono/jsx/dom',
  logLevel: 'info',
};

if (process.argv.includes('--watch')) {
  const ctx = await context(options);
  await ctx.watch();
  console.log('watching client bundle…');
} else {
  await build(options);
}
