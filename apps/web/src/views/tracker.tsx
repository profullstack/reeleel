/** @jsxImportSource hono/jsx */
import type { FC } from 'hono/jsx';

/**
 * The CrawlProof project this deployment reports to. Every hosted page on
 * reeleel.com belongs to this project; the dashboard lives at
 * https://crawlproof.com/projects/<id>/stats.
 */
const DEFAULT_SITE_ID = '373d56d4-9b59-4259-a43f-ebd057a1f33b';

const SRC = 'https://crawlproof.com/stats.js';

/**
 * Resolve the site id, honouring an explicit override.
 *
 * This app is self-hostable and the desktop build runs offline by design, so a
 * hardcoded beacon would be wrong for anyone but us. Setting
 * `REELEEL_STATS_SITE_ID` to an empty string (or `off`) drops the tag entirely;
 * setting it to another id points a fork at its own project.
 */
export const statsSiteId = (): string => {
  const override = process.env['REELEEL_STATS_SITE_ID'];
  if (override === undefined) return DEFAULT_SITE_ID;
  const trimmed = override.trim();
  return trimmed === '' || trimmed.toLowerCase() === 'off' ? '' : trimmed;
};

/**
 * CrawlProof's drop-in tracker. It is `defer`red rather than inline because
 * nothing on the page waits on it, and analytics must never be the reason a
 * page is slow to render.
 *
 * Note for anyone porting a snippet from our other apps: those are Next.js and
 * use `next/script`. There is no `next/script` here — these pages are Hono JSX
 * rendered to a string on the server, so this has to be a plain `<script>`.
 */
export const StatsTracker: FC = () => {
  const site = statsSiteId();
  if (!site) return null;
  return <script defer data-site={site} src={SRC} />;
};
