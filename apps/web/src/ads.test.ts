import { afterEach, describe, expect, it } from 'vitest';

import { LandingPage } from './views/landing.js';
import { AdUnit, adSlotId } from './views/ads.js';

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
  it('the public landing page (homepage) carries no ad', async () => {
    const html = await render();
    expect(html).not.toContain('data-cp-ad');
    expect(html).not.toContain('crawlproof.com/ad.js');
  });

  it('renders as one low-profile text_link unit', async () => {
    const html = String(await AdUnit({}));
    expect(html.match(/data-cp-ad/g)).toHaveLength(1);
    expect(html).toContain(`data-slot="${SLOT}"`);
    expect(html).toContain('data-format="text_link"');
  });

  it('can be switched off for a self-hosted build', async () => {
    process.env['REELEEL_AD_SLOT'] = 'off';
    expect(adSlotId()).toBe('');
    expect(String(await AdUnit({}) ?? '')).not.toContain('data-cp-ad');
  });
});
