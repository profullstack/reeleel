import { describe, expect, it } from 'vitest';

import { MANIFEST, SERVICE_WORKER } from './pwa.js';

/**
 * These assertions look pedantic. They exist because the previous service
 * worker served `/client.js` cache-first under a version constant that never
 * changed, which pinned every returning browser to the JavaScript it saw
 * first — permanently, and invisibly to anyone deploying.
 *
 * The client bundle is what turns the import form into the resumable uploader,
 * so a stale copy silently downgrades the app and no server-side deploy can
 * reach the user. That is worth a regression test.
 */
describe('service worker', () => {
  it('fetches the client bundle from the network first', () => {
    // The bundle must be in the network-first list, not the cache-first one.
    expect(SERVICE_WORKER).toMatch(/const FRESH = \[[^\]]*'\/client\.js'/);
    expect(SERVICE_WORKER).not.toMatch(/const STATIC = \[[^\]]*'\/client\.js'/);
  });

  it('still falls back to the cache when the network is gone', () => {
    // Offline is the whole reason the cache is kept at all.
    expect(SERVICE_WORKER).toMatch(/\.catch\(\(\) => caches\.match\(request\)\)/);
  });

  it('takes over immediately rather than waiting for every tab to close', () => {
    expect(SERVICE_WORKER).toContain('skipWaiting');
    expect(SERVICE_WORKER).toContain('clients.claim');
  });

  it('drops caches from previous versions on activate', () => {
    expect(SERVICE_WORKER).toMatch(/keys\.filter\(\(k\) => k !== CACHE\)\.map\(\(k\) => caches\.delete\(k\)\)/);
  });

  it('never caches API responses', () => {
    expect(SERVICE_WORKER).toContain("url.pathname.startsWith('/api/')");
  });

  it('only ever caches same-origin GETs', () => {
    expect(SERVICE_WORKER).toContain("request.method !== 'GET'");
    expect(SERVICE_WORKER).toContain('url.origin !== self.location.origin');
  });
});

describe('manifest', () => {
  it('is installable: name, start_url, display and an icon', () => {
    expect(MANIFEST.name.length).toBeGreaterThan(0);
    expect(MANIFEST.start_url).toBe('/');
    expect(MANIFEST.display).toBe('standalone');
    expect(MANIFEST.icons.length).toBeGreaterThan(0);
  });
});
