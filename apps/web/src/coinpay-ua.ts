import { createRequire } from 'node:module';

/** apps/web/package.json: one level up from both src/ and the built dist/. */
function appVersion(): string | undefined {
  try {
    return (createRequire(import.meta.url)('../package.json') as { version?: string }).version;
  } catch {
    return process.env.npm_package_version;
  }
}
const version = appVersion();

/**
 * User-Agent for server-side calls to CoinPay. Every fleet app shares one
 * public IP on dev2, so CoinPay's logs and throttle tell the apps apart by
 * this header instead of a bare `Bun/x.y.z`.
 */
export const COINPAY_UA = `reeleel.com${version ? `/${version}` : ''} (+https://reeleel.com)`;

/** fetch that adds COINPAY_UA unless the caller already set a User-Agent. */
export const coinpayFetch = ((input: RequestInfo | URL, init: RequestInit = {}) => {
  const headers = new Headers(init.headers);
  if (!headers.has('user-agent')) headers.set('user-agent', COINPAY_UA);
  return fetch(input, { ...init, headers });
}) as typeof fetch;
