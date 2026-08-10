/**
 * @reeleel/core — every service the apps share.
 *
 * The CLI, the desktop app and the PWA all call into this package; none of them
 * reach past it into SQLite or FFmpeg directly. That is what keeps the GUI and
 * the CLI honest about being the same product.
 */
export * from './analyze.js';
export * from './athletes.js';
export * from './camera.js';
export * from './candidates.js';
export * from './clips.js';
export * from './config.js';
export * from './dataset.js';
export * from './doctor.js';
export * from './errors.js';
export * from './ffmpeg.js';
export * from './ids.js';
export * from './jobs.js';
export * from './layout.js';
export * from './media.js';
export * from './models.js';
export * from './moments.js';
export * from './projects.js';
export * from './reels.js';
export * from './commentary.js';
export * from './render.js';
export * from './voice.js';
export * from './scoring.js';
export * from './tracks.js';
export * from './types.js';
export * from './videos.js';

export {
  all,
  changes,
  closeDatabases,
  execute,
  get,
  globalDb,
  parseJson,
  projectDb,
  resetDbCache,
  toNumber,
  withGlobalDb,
  withProjectDb,
} from './db.js';
export type { Client } from './db.js';

export {
  DEFAULT_SPORT,
  PLANNED_SPORTS,
  getSport,
  isKnownSport,
  listSports,
  requiredClasses,
} from '@reeleel/sports';
export type { MomentRule, SportClass, SportPlugin } from '@reeleel/sports';
