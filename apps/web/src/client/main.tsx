import { mountIdentify } from './identify.js';
import { mountMoments } from './moments.js';
import { mountOverlays } from './overlay.js';
import { mountReview } from './review.js';
import { mountJobLog } from './jobs.js';
import { mountUploads } from './upload.js';

/**
 * The client entry point: mount every island the page happens to contain.
 *
 * Each mount looks for its own anchor and returns quietly if the page has none,
 * so this one list serves every page. Everything not listed here stays plain
 * SSR, which keeps the app usable with JavaScript disabled.
 */

const mount = (): void => {
  // Proof the bundle ran, so the stylesheet can hide instructions that only
  // make sense without it.
  document.documentElement.classList.add('js');
  mountUploads();
  mountJobLog();
  mountIdentify();
  // Boxes over each moment's player, so "what did it actually detect" is
  // answerable by looking rather than by reading counts.
  mountOverlays();
  // The review surface: every track over the whole game, click to identify.
  mountReview();
  // The moment list, which live.ts also re-mounts after a refresh.
  mountMoments();
};

mount();
