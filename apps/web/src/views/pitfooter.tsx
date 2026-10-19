/** @jsxImportSource hono/jsx */
import { raw } from 'hono/html';

/**
 * The pit.world network footer, fetched on the server and rendered as the last
 * thing in <body> on every page.
 *
 * Module-level cache, warmed when this module loads: a render never waits on
 * the network, it serves the cached copy and, when that is over an hour old,
 * starts one background refresh (3s timeout). Any failure keeps the last good
 * copy, or renders nothing: the footer must never break or slow a page. Tests
 * never touch the network.
 */
const PIT_FOOTER_URL = 'https://pit.world/snippets/footer.html?site=reeleel.com';
const MAX_AGE_MS = 60 * 60 * 1000;
const RETRY_MS = 5 * 60 * 1000;

let html = '';
let fetchedAt = 0;
let inflight: Promise<void> | null = null;

function refresh(): Promise<void> {
  inflight ??= (async () => {
    try {
      const res = await fetch(PIT_FOOTER_URL, { signal: AbortSignal.timeout(3000) });
      const body = res.ok ? await res.text() : '';
      if (body.includes('data-pit-footer')) {
        html = body;
        fetchedAt = Date.now();
      } else {
        fetchedAt = Date.now() - MAX_AGE_MS + RETRY_MS;
      }
    } catch {
      fetchedAt = Date.now() - MAX_AGE_MS + RETRY_MS;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

export function pitFooterHtml(): string {
  if (process.env.VITEST) return '';
  if (Date.now() - fetchedAt > MAX_AGE_MS) void refresh();
  return html;
}

if (!process.env.VITEST) void refresh();

export const PitFooter = () => raw(pitFooterHtml());
