/**
 * The `accept` attribute for a footage file input.
 *
 * Extensions come first and carry the real weight. MIME types alone are not
 * enough: the browser has to map `video/webm` back to `.webm` through the
 * platform's mime database, and on Linux that map is routinely incomplete —
 * which is how the picker ended up showing only `.mp4` even though every other
 * container was already supported server-side. Extensions are matched by the
 * browser directly, with no platform lookup in the way. The MIME entries stay
 * for pickers that group by type, and `video/*` so a container we have not
 * enumerated is still reachable — the server, not the dialog, decides what is
 * importable.
 *
 * This list is deliberately not imported from `@reeleel/core`: this module is
 * bundled into the browser, and core reaches for `node:fs`. `accept.test.ts`
 * asserts every extension core supports appears here, so the two cannot drift.
 */
export const FILE_INPUT_ACCEPT = [
  '.mp4',
  '.m4v',
  '.mov',
  '.qt',
  '.3gp',
  '.3g2',
  '.mts',
  '.m2ts',
  '.m2t',
  '.ts',
  '.mkv',
  '.webm',
  '.ogv',
  '.avi',
  '.divx',
  '.mpg',
  '.mpeg',
  '.mpe',
  '.m1v',
  '.m2v',
  '.vob',
  '.wmv',
  '.asf',
  '.mxf',
  '.dv',
  '.dif',
  '.flv',
  '.f4v',
  '.insv',
  '.h264',
  '.264',
  '.h265',
  '.265',
  '.hevc',
  'video/*',
  'video/mp4',
  'video/quicktime',
  'video/x-matroska',
  'video/webm',
  'video/mp2t',
  'video/x-msvideo',
  'video/mpeg',
  'video/x-ms-wmv',
  'video/3gpp',
  'video/3gpp2',
].join(',');
