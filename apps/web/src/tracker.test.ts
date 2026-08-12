import { afterEach, describe, expect, it } from 'vitest';

import { Layout } from './views/Layout.js';
import { LandingPage } from './views/landing.js';
import { StatsTracker, statsSiteId } from './views/tracker.js';

/**
 * The analytics tag went missing for a month without anyone noticing: the
 * dashboard just showed zero, which looks identical to "no traffic yet". The
 * snippet we were handed was a Next.js `<Script>` — these pages are Hono JSX,
 * so it could never have rendered here.
 *
 * These assert the tag is actually in the served markup of both shells, since
 * that is the part no one can see is broken by reading the code.
 */

const SITE = '373d56d4-9b59-4259-a43f-ebd057a1f33b';

afterEach(() => {
  delete process.env['REELEEL_STATS_SITE_ID'];
});

describe('the stats tracker', () => {
  it('ships on the public landing page', async () => {
    const html = String(await LandingPage({ signedIn: false }));
    expect(html).toContain('https://crawlproof.com/stats.js');
    expect(html).toContain(`data-site="${SITE}"`);
  });

  it('ships on the signed-in app shell too', async () => {
    const html = String(await Layout({ title: 'Projects', children: 'x' }));
    expect(html).toContain('https://crawlproof.com/stats.js');
    expect(html).toContain(`data-site="${SITE}"`);
  });

  it('does not block rendering', async () => {
    const html = String(await LandingPage({ signedIn: false }));
    // A synchronous analytics tag would put a third party on the critical path.
    expect(html).toMatch(/<script[^>]*defer[^>]*stats\.js/);
  });

  it('can be turned off, so a self-hosted instance reports nothing', async () => {
    process.env['REELEEL_STATS_SITE_ID'] = 'off';
    expect(statsSiteId()).toBe('');
    expect(await StatsTracker({})).toBeNull();

    process.env['REELEEL_STATS_SITE_ID'] = '';
    expect(statsSiteId()).toBe('');
  });

  it('lets a fork point at its own project', async () => {
    process.env['REELEEL_STATS_SITE_ID'] = 'someone-elses-id';
    expect(statsSiteId()).toBe('someone-elses-id');
  });
});
