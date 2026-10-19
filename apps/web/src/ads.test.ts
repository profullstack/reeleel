import { afterEach, describe, expect, it } from 'vitest';

import { LandingPage } from './views/landing.js';
import { adSlotId } from './views/ads.js';

/**
 * The ad unit is client-filled, so a missing tag looks exactly like an unsold
 * slot. These pin it into the served markup of the public page.
 */

const SLOT = '4324604c-df20-4c84-b106-e7d21eb0e45f';

const render = async (): Promise<string> =>
  String(await LandingPage({ signedIn: false }));

afterEach(() => {
  delete process.env['REELEEL_AD_SLOT'];
});

describe('the CrawlProof ad unit', () => {
  it('ships exactly one unit on the public landing page', async () => {
    const html = await render();
    expect(html.match(/data-cp-ad/g)).toHaveLength(1);
    expect(html).toContain(`data-slot="${SLOT}"`);
    expect(html).toMatch(/<script[^>]*async[^>]*crawlproof\.com\/ad\.js/);
  });

  it('sits at the top of the content, not down by the footer', async () => {
    const html = await render();
    expect(html.indexOf('data-cp-ad')).toBeLessThan(html.indexOf('id="how"'));
  });

  it('can be switched off for a self-hosted build', async () => {
    process.env['REELEEL_AD_SLOT'] = 'off';
    expect(adSlotId()).toBe('');
    const html = await render();
    expect(html).not.toContain('data-cp-ad');
    expect(html).not.toContain('ad.js');
  });
});
