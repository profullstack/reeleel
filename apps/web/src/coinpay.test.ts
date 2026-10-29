import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * The callback is where Sign in with CoinPay is won or lost: a state that did
 * not start in this browser, a replayed state, or a Connect that finishes in
 * another session must all be refused before the code is ever exchanged.
 */

let home: string;

beforeAll(() => {
  home = mkdtempSync(path.join(tmpdir(), 'reeleel-web-coinpay-'));
  process.env['REELEEL_HOME'] = home;
});

afterAll(async () => {
  const { resetDbCache } = await import('@reeleel/core');
  resetDbCache();
  rmSync(home, { recursive: true, force: true });
  delete process.env['REELEEL_HOME'];
});

const CONFIG = {
  clientId: 'cp_test',
  clientSecret: 'not-a-real-secret',
  redirectUri: 'https://reeleel.test/api/v1/coinpay/oauth/callback',
};

const build = async (finishResult: { sub: string; email: string | null; name: string | null }) => {
  const { registerCoinpayRoutes, STATE_COOKIE } = await import('./coinpay.js');
  const finish = vi.fn(async () => ({ ...finishResult, claims: {}, userinfo: {}, tokens: {} }));
  const app = new Hono();
  registerCoinpayRoutes(app, {
    config: () => CONFIG,
    signupAllowed: () => true,
    mailer: { name: 'test', configured: false, send: async () => {} },
    finish: finish as never,
  });
  return { app, finish, STATE_COOKIE };
};

const cookieValue = (res: Response, name: string): string | null => {
  const header = res.headers.get('set-cookie') ?? '';
  const match = new RegExp(`${name}=([^;]*)`).exec(header);
  return match === null ? null : decodeURIComponent(match[1] ?? '');
};

const start = async (app: Hono, query = '', cookie = '') => {
  const res = await app.request(`https://reeleel.test/api/v1/coinpay/oauth/start${query}`, {
    headers: cookie.length > 0 ? { cookie } : {},
  });
  return res;
};

const TIMEOUT = 25_000;

describe('Sign in with CoinPay routes', () => {
  it(
    'starts with PKCE S256, state and nonce, and pins state to this browser',
    async () => {
      const { app, STATE_COOKIE } = await build({ sub: 's-start', email: null, name: null });
      const res = await start(app, '?next=%2Fprojects');
      expect(res.status).toBe(302);
      const location = new URL(res.headers.get('location') ?? '');
      expect(location.origin + location.pathname).toBe('https://coinpayportal.com/api/oauth/authorize');
      expect(location.searchParams.get('code_challenge_method')).toBe('S256');
      expect(location.searchParams.get('code_challenge')).toBeTruthy();
      expect(location.searchParams.get('nonce')).toBeTruthy();
      expect(location.searchParams.get('redirect_uri')).toBe(CONFIG.redirectUri);
      expect(location.searchParams.get('scope')).toBe('openid profile email');
      expect(cookieValue(res, STATE_COOKIE)).toBe(location.searchParams.get('state'));
    },
    TIMEOUT,
  );

  it(
    'rejects a forged or replayed state without exchanging the code',
    async () => {
      const { app, finish, STATE_COOKIE } = await build({ sub: 's-forged', email: null, name: null });
      const res = await start(app);
      const state = cookieValue(res, STATE_COOKIE) ?? '';

      const forged = await app.request(
        `https://reeleel.test/api/v1/coinpay/oauth/callback?code=c&state=${encodeURIComponent('attacker')}`,
        { headers: { cookie: `${STATE_COOKIE}=attacker-too` } },
      );
      expect(forged.status).toBe(400);

      const noCookie = await app.request(
        `https://reeleel.test/api/v1/coinpay/oauth/callback?code=c&state=${encodeURIComponent(state)}`,
      );
      expect(noCookie.status).toBe(400);
      expect(finish).not.toHaveBeenCalled();

      const ok = await app.request(
        `https://reeleel.test/api/v1/coinpay/oauth/callback?code=c&state=${encodeURIComponent(state)}`,
        { headers: { cookie: `${STATE_COOKIE}=${state}` } },
      );
      expect(ok.status).toBe(302);
      expect(finish).toHaveBeenCalledTimes(1);

      const replay = await app.request(
        `https://reeleel.test/api/v1/coinpay/oauth/callback?code=c&state=${encodeURIComponent(state)}`,
        { headers: { cookie: `${STATE_COOKIE}=${state}` } },
      );
      expect(replay.status).toBe(400);
      expect(finish).toHaveBeenCalledTimes(1);
    },
    TIMEOUT,
  );

  it(
    'gives a matching CoinPay email its own new account, not the existing one',
    async () => {
      const { createUser, USER_COOKIE, userForSession } = await import('@reeleel/api');
      const victim = await createUser({ email: 'owner@example.com', password: 'owner-password-1' });
      const { app, STATE_COOKIE } = await build({ sub: 's-collide', email: 'owner@example.com', name: null });
      const state = cookieValue(await start(app), STATE_COOKIE) ?? '';

      const res = await app.request(
        `https://reeleel.test/api/v1/coinpay/oauth/callback?code=c&state=${encodeURIComponent(state)}`,
        { headers: { cookie: `${STATE_COOKIE}=${state}` } },
      );
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('/verify/email');
      const session = cookieValue(res, USER_COOKIE) ?? '';
      const user = await userForSession(session);
      expect(user).not.toBeNull();
      expect(user?.id).not.toBe(victim.id);
      expect(user?.email).not.toBe('owner@example.com');
    },
    TIMEOUT,
  );

  it(
    'needs a session to connect CoinPay, and the same session to finish',
    async () => {
      const { createUser, createUserSession, USER_COOKIE, coinpayIdentityForUser } = await import('@reeleel/api');
      const { app, finish, STATE_COOKIE } = await build({ sub: 's-link', email: null, name: null });

      const anonymous = await start(app, '?link=1');
      expect(anonymous.status).toBe(302);
      expect(anonymous.headers.get('location')).toBe('/login?next=%2Faccount');

      const dana = await createUser({ email: 'dana@example.com', password: 'dana-password-12' });
      const session = await createUserSession(dana.id);
      const res = await start(app, '?link=1', `${USER_COOKIE}=${session}`);
      const state = cookieValue(res, STATE_COOKIE) ?? '';

      // Finishing without the session that asked is refused.
      const hijack = await app.request(
        `https://reeleel.test/api/v1/coinpay/oauth/callback?code=c&state=${encodeURIComponent(state)}`,
        { headers: { cookie: `${STATE_COOKIE}=${state}` } },
      );
      expect(hijack.status).toBe(403);
      expect(finish).not.toHaveBeenCalled();
      expect(await coinpayIdentityForUser(dana.id)).toBeNull();

      const again = await start(app, '?link=1', `${USER_COOKIE}=${session}`);
      const state2 = cookieValue(again, STATE_COOKIE) ?? '';
      const linked = await app.request(
        `https://reeleel.test/api/v1/coinpay/oauth/callback?code=c&state=${encodeURIComponent(state2)}`,
        { headers: { cookie: `${STATE_COOKIE}=${state2}; ${USER_COOKIE}=${session}` } },
      );
      expect(linked.status).toBe(302);
      expect(linked.headers.get('location')).toContain('/account?ok=');
      expect((await coinpayIdentityForUser(dana.id))?.sub).toBe('s-link');
    },
    TIMEOUT,
  );
});
