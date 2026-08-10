/**
 * Progressive web app plumbing.
 *
 * The service worker deliberately does NOT cache API responses or pages behind
 * auth: a stale project list is worse than an honest offline message, and
 * caching an authenticated response risks serving it to the next person on a
 * shared device. It caches the app shell and the client bundle only.
 */

/** Inline SVG icon, embedded so the app installs without extra asset files. */
const ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="96" fill="#0f766e"/>
  <path d="M136 168c60-28 180-28 240 0 18 8 18 168 0 176-60 28-180 28-240 0-18-8-18-168 0-176z" fill="none" stroke="#fff" stroke-width="28" stroke-linejoin="round"/>
  <circle cx="256" cy="256" r="44" fill="#fff"/>
</svg>`;

export const ICON_SVG = ICON;

export const MANIFEST = {
  name: 'ReelEel',
  short_name: 'ReelEel',
  description: 'Local-first youth-sports highlight reels.',
  start_url: '/',
  scope: '/',
  display: 'standalone',
  orientation: 'any',
  background_color: '#0f1115',
  theme_color: '#0f766e',
  /**
   * Real PNGs at the sizes installers ask for. An SVG-only icon list is
   * accepted by the manifest spec and quietly ignored by several Android
   * launchers, which then fall back to a screenshot of the page.
   *
   * `maskable` is deliberately not claimed: the mascot is drawn to its own
   * edges, and a launcher that crops a maskable icon to a circle would take the
   * bat off.
   */
  icons: [
    { src: '/brand/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: '/brand/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
  ],
} as const;

export const SERVICE_WORKER = `// ReelEel service worker.
//
// /client.js is NETWORK-FIRST, and that is not a preference — it is a bug fix.
// A cache-first bundle under a version constant that never changes pins every
// returning browser to whatever JavaScript it saw first, permanently. That is
// not a stale-pixel problem: the client bundle is what turns the import form
// into the resumable uploader, so a stale copy silently downgrades the app to
// a plain form post and no amount of server-side deploying can reach the user.
// It cost exactly that once already.
//
// The cache is still there, but only as an offline fallback: the network wins
// whenever it answers.
const CACHE = 'reeleel-shell-v2';
// Assets that are safe to serve from cache first — they change with the icon,
// not with the code.
const STATIC = ['/icon.svg', '/manifest.webmanifest'];
const FRESH = ['/client.js'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll([...STATIC, ...FRESH]))
      // Never leave a fixed bug sitting behind an old worker waiting for every
      // tab to close.
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // Never cache data or anything behind authentication.
  if (url.pathname.startsWith('/api/')) return;

  if (FRESH.includes(url.pathname)) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response && response.ok) {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        // Offline: a known-good bundle beats a broken page.
        .catch(() => caches.match(request)),
    );
    return;
  }

  if (!STATIC.includes(url.pathname)) return;
  event.respondWith(caches.match(request).then((hit) => hit || fetch(request)));
});
`;
