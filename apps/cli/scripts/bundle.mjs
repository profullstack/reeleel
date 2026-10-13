#!/usr/bin/env node
// Bundles the CLI for npm as @profullstack/reeleel.
//
// The workspace packages (@reeleel/core, @reeleel/db, @reeleel/sports) are not
// published, so they are compiled into bundle/reeleel.js. Real npm packages stay
// external and are listed as dependencies in package.json. The SQL migrations
// are copied next to the bundle: @reeleel/db finds them with
// new URL('../migrations/', import.meta.url), and bundle/ is one level down
// from the package root, exactly like packages/db/dist.
import { build } from 'esbuild';
import { cpSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const packages = join(root, '..', '..', 'packages');
const db = join(packages, 'db');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

for (const dir of ['bundle', 'migrations', 'migrations-pg']) {
  rmSync(join(root, dir), { recursive: true, force: true });
}

await build({
  entryPoints: [join(root, 'src/index.ts')],
  outfile: join(root, 'bundle/reeleel.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: Object.keys(pkg.dependencies ?? {}),
  // Bundle the workspace packages from source, so this does not depend on
  // their dist/ having been built first (bun's --filter order is not a promise).
  alias: Object.fromEntries(
    ['core', 'db', 'sports'].map((name) => [
      `@reeleel/${name}`,
      join(packages, name, 'src', 'index.ts'),
    ]),
  ),
  // src/index.ts already carries the shebang; esbuild keeps it.
  logLevel: 'warning',
});

cpSync(join(db, 'migrations'), join(root, 'migrations'), { recursive: true });
cpSync(join(db, 'migrations-pg'), join(root, 'migrations-pg'), { recursive: true });
