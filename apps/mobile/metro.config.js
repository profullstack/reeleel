const path = require('node:path');

const { getDefaultConfig } = require('expo/metro-config');

/**
 * Metro treats the app directory as the world. @reeleel/client lives outside it
 * (linked in by the `file:` dependency), so Metro has to be told to watch the
 * repository root and to follow the symlink — otherwise the bundle fails with
 * "Unable to resolve module @reeleel/client" even though npm linked it fine.
 */
const projectRoot = __dirname;
const repoRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

config.watchFolders = [repoRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(repoRoot, 'node_modules'),
];
config.resolver.unstable_enableSymlinks = true;

module.exports = config;
