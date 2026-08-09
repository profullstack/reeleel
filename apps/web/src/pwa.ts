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
  icons: [
    { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
    { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'maskable' },
  ],
} as const;

export const SERVICE_WORKER = `// ReelEel service worker.
const CACHE = 'reeleel-shell-v1';
const SHELL = ['/client.js', '/icon.svg', '/manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
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
  if (!SHELL.includes(url.pathname)) return;

  event.respondWith(
    caches.match(request).then((hit) => hit || fetch(request)),
  );
});
`;
