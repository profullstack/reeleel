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
 * No `data-format`: ad.js picks one from the unit's measured width (728x90 on
 * a desktop column, 300x250 on a phone), which is one request for one
 * impression. ad.js prepends its own "Advertisement" caption, so there is no
 * label here. Collapsed until filled by the `.cp-ad` rules in the page styles.
 */
export const AdUnit: FC = () => {
  const slot = adSlotId();
  if (!slot) return null;
  return (
    <>
      <aside class="cp-ad" data-cp-ad="" data-slot={slot} />
      <script async src={SRC} />
    </>
  );
};

/**
 * Zero height until ad.js starts a fill (it sets `data-cp-filled`, and removes
 * it again on an empty response), so an unsold or blocked slot leaves no hole.
 * On a phone the unit escapes the column's gutter so a 300px rectangle is not
 * cropped by a 272px column.
 */
export const AD_STYLES = `
  .cp-ad { display: flex; flex-direction: column; align-items: center; height: 0; overflow: hidden; }
  .cp-ad[data-cp-filled] { height: auto; margin: 2.5rem 0 0; }
  @media (max-width: 640px) {
    .cp-ad { width: 100vw; margin-inline: calc(50% - 50vw); }
    .cp-ad[data-cp-filled] { margin: 2.5rem calc(50% - 50vw) 0; }
  }
`;
