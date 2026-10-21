/** @jsxImportSource hono/jsx */
import type { FC } from 'hono/jsx';

/**
 * The CrawlProof ad slot for reeleel.com. Manage it at
 * https://crawlproof.com/ads/slots.
 */
const DEFAULT_AD_SLOT = '4324604c-df20-4c84-b106-e7d21eb0e45f';

const SRC = 'https://crawlproof.com/ad.js';

/**
 * Resolve the ad slot, honouring an explicit override — the same rule as the
 * stats tag. A self-hosted or offline build must not serve our ads, so
 * `REELEEL_AD_SLOT` set to an empty string (or `off`) drops the unit and the
 * script entirely; another id points a fork at its own slot.
 */
export const adSlotId = (): string => {
  const override = process.env['REELEEL_AD_SLOT'];
  if (override === undefined) return DEFAULT_AD_SLOT;
  const trimmed = override.trim();
  return trimmed === '' || trimmed.toLowerCase() === 'off' ? '' : trimmed;
};

/**
 * One CrawlProof ad unit. These pages are server-rendered strings, so the
 * unit is in the markup before ad.js runs and its own DOMContentLoaded pass
 * fills it — no manual `crawlproofAds.scan()` is needed here.
 *
 * Always the low-profile text_link line (40px, fluid, its own "Sponsored"
 * mark). The homepage carries no ad. Collapsed until filled by the `.cp-ad`
 * rules in the page styles.
 */
export const AdUnit: FC = () => {
  const slot = adSlotId();
  if (!slot) return null;
  return (
    <>
      <aside class="cp-ad" data-cp-ad="" data-slot={slot} data-format="text_link" />
      <script async src={SRC} />
    </>
  );
};

/**
 * Zero height until ad.js starts a fill (it sets `data-cp-filled`, and removes
 * it again on an empty response), so an unsold or blocked slot leaves no hole.
 */
export const AD_STYLES = `
  .cp-ad { display: block; width: 100%; height: 0; overflow: hidden; }
  .cp-ad[data-cp-filled] { height: auto; margin: 0.5rem 0; }
`;
