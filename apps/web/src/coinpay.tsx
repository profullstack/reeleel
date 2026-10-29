/** @jsxImportSource hono/jsx */
import { authorizeUrl, finishSignIn, pkce, randomToken, sameState, SIGN_IN_SCOPES } from '@profullstack/coinpay-onboard/oauth';
import type { Context, Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';

import {
  DEFAULT_SESSION_SECONDS,
  EmailClaimError,
  PENDING_TTL_SECONDS,
  baseUrl,
  clientKey,
  coinpayIdentityForUser,
  consumeEmailClaim,
  createUserSession,
  hasPasswordLogin,
  isPlaceholderEmail,
  loginAttemptAllowed,
  originAllowed,
  readCoinpayConfig,
  readEmailConfig,
  requestEmailClaim,
  resolveUserFromRequest,
  savePending,
  setUserCookie,
  signInWithCoinpay,
  takePending,
  unlinkCoinpay,
  currentUser,
} from '@reeleel/api';
import type { CoinpayConfig, Mailer } from '@reeleel/api';

import { AccountPage, AddEmailPage, LoginPage, MessagePage, VerifyNoticePage } from './views/auth.js';

/** Holds `state` in the browser that started the login, so a link cannot finish it. */
export const STATE_COOKIE = 'reeleel_cp_state';
const STATE_COOKIE_PATH = '/api/v1/coinpay/oauth';

const safeNext = (value: unknown): string => {
  if (typeof value !== 'string' || value.length === 0) return '/';
  if (!value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return '/';
  return value;
};

export interface CoinpayRouteOptions {
  config?: () => CoinpayConfig | null;
  signupAllowed: () => boolean;
  mailer: Mailer;
  /** Injectable for tests; the real one talks to coinpayportal.com. */
  finish?: typeof finishSignIn;
}

const FAILURES: Record<string, string> = {
  LINKED_ELSEWHERE: 'That CoinPay account is already connected to a different ReelEel account.',
  ALREADY_LINKED: 'This account is already connected to a different CoinPay account.',
  SIGNUP_CLOSED: 'No ReelEel account is connected to that CoinPay account, and registration is closed.',
  DISABLED: 'That account is disabled.',
  NO_USER: 'That account no longer exists.',
};

/**
 * Sign in with CoinPay: start, callback and the add-an-address step. All of it
 * is reachable without a session (see PUBLIC_PATHS); Connect CoinPay checks
 * for one itself.
 */
export const registerCoinpayRoutes = (app: Hono, options: CoinpayRouteOptions): void => {
  const config = options.config ?? (() => readCoinpayConfig());
  const finish = options.finish ?? finishSignIn;

  const loginError = (c: Context, message: string, status: 400 | 403 | 409 | 502 = 400) =>
    c.html(
      <LoginPage error={message} signupAllowed={options.signupAllowed()} coinpay={config() !== null} />,
      status,
    );

  app.get('/api/v1/coinpay/oauth/start', async (c) => {
    const cfg = config();
    if (cfg === null) return c.redirect('/login');
    if (!loginAttemptAllowed(`coinpay:${clientKey(c)}`)) {
      return loginError(c, 'Too many attempts. Wait a few minutes.', 403);
    }

    let linkUserId: string | null = null;
    if (c.req.query('link') === '1') {
      // Connecting CoinPay only ever happens from inside the account it joins.
      const user = await resolveUserFromRequest(c);
      if (user === null) return c.redirect(`/login?next=${encodeURIComponent('/account')}`);
      linkUserId = user.id;
    }

    const state = randomToken();
    const nonce = randomToken();
    const { verifier, challenge } = pkce();
    await savePending(state, { verifier, nonce, next: safeNext(c.req.query('next')), linkUserId });
    setCookie(c, STATE_COOKIE, state, {
      httpOnly: true,
      sameSite: 'Lax',
      path: STATE_COOKIE_PATH,
      maxAge: PENDING_TTL_SECONDS,
      secure: new URL(c.req.url).protocol === 'https:',
    });
    return c.redirect(
      authorizeUrl({
        clientId: cfg.clientId,
        redirectUri: cfg.redirectUri,
        state,
        challenge,
        nonce,
        scopes: SIGN_IN_SCOPES,
      }),
    );
  });

  app.get('/api/v1/coinpay/oauth/callback', async (c) => {
    const cfg = config();
    if (cfg === null) return c.redirect('/login');

    const state = c.req.query('state') ?? '';
    const expected = getCookie(c, STATE_COOKIE);
    deleteCookie(c, STATE_COOKIE, { path: STATE_COOKIE_PATH });

    if (!sameState(expected, state)) {
      return loginError(c, 'That sign-in link is not from this browser. Start again.');
    }
    const pending = await takePending(state);
    if (pending === null) return loginError(c, 'That sign-in has expired. Start again.');

    if (c.req.query('error') !== undefined) {
      return loginError(c, 'CoinPay sign-in was cancelled.');
    }
    const code = c.req.query('code') ?? '';
    if (code.length === 0) return loginError(c, 'CoinPay did not return a code. Start again.');

    if (pending.linkUserId !== null) {
      // The session that asked to connect must still be the one finishing it.
      const user = await resolveUserFromRequest(c);
      if (user === null || user.id !== pending.linkUserId) {
        return loginError(c, 'Sign in to the account you want to connect, then try again.', 403);
      }
    }

    let profile: { sub: string; email: string | null; name: string | null };
    try {
      const result = await finish({
        code,
        verifier: pending.verifier,
        nonce: pending.nonce,
        clientId: cfg.clientId,
        clientSecret: cfg.clientSecret,
        redirectUri: cfg.redirectUri,
      });
      profile = { sub: result.sub, email: result.email, name: result.name };
    } catch (error) {
      process.stderr.write(`coinpay sign-in failed: ${String(error)}\n`);
      return loginError(c, 'CoinPay sign-in could not be completed. Start again.', 502);
    }

    const outcome = await signInWithCoinpay(profile, {
      linkUserId: pending.linkUserId,
      signupAllowed: options.signupAllowed(),
    });
    if (!outcome.ok) {
      if (pending.linkUserId !== null) {
        return c.redirect(`/account?err=${encodeURIComponent(FAILURES[outcome.code] ?? 'Could not connect CoinPay.')}`);
      }
      return loginError(c, FAILURES[outcome.code] ?? 'CoinPay sign-in failed.', 409);
    }

    if (pending.linkUserId !== null) {
      return c.redirect(`/account?ok=${encodeURIComponent('CoinPay connected.')}`);
    }
    setUserCookie(c, await createUserSession(outcome.user.id), DEFAULT_SESSION_SECONDS);
    return c.redirect(isPlaceholderEmail(outcome.user.email) ? '/verify/email' : pending.next);
  });

  // ── A CoinPay-only account adds an address it can prove ──────────────────

  app.get('/verify/email', async (c) => {
    const token = c.req.query('token');
    if (token !== undefined) {
      const userId = await consumeEmailClaim(token);
      if (userId === null) {
        return c.html(
          <MessagePage
            title="That link has expired"
            body="Links last 24 hours and can only be used once, and the address must not belong to another account. Sign in to try again."
            linkHref="/login"
            linkText="Sign in"
          />,
          400,
        );
      }
      return c.html(
        <MessagePage
          title="Email confirmed"
          body="Your address is confirmed and your account is ready."
          linkHref="/"
          linkText="Go to your projects"
        />,
      );
    }

    const user = await resolveUserFromRequest(c);
    if (user === null) return c.redirect('/login');
    if (!isPlaceholderEmail(user.email)) return c.redirect('/');
    return c.html(<AddEmailPage />);
  });

  app.post('/verify/email', async (c) => {
    if (!originAllowed(c)) return c.text('Bad origin', 403);
    const user = await resolveUserFromRequest(c);
    if (user === null) return c.redirect('/login');
    if (!isPlaceholderEmail(user.email)) return c.redirect('/');

    const body = await c.req.parseBody();
    const address = typeof body['email'] === 'string' ? body['email'] : '';
    if (!loginAttemptAllowed(`claim:${clientKey(c)}`)) {
      return c.html(<AddEmailPage error="Too many attempts. Wait a few minutes." email={address} />, 429);
    }
    try {
      const token = await requestEmailClaim(user.id, address);
      const link = `${baseUrl(readEmailConfig(), c.req.url)}/verify/email?token=${encodeURIComponent(token)}`;
      let delivered = false;
      try {
        await options.mailer.send({
          to: address.trim(),
          subject: 'Confirm your ReelEel email',
          text: [
            'You signed in to ReelEel with CoinPay and asked to use this address.',
            '',
            'Confirm it:',
            link,
            '',
            'The link expires in 24 hours. If this was not you, ignore this email.',
          ].join('\n'),
        });
        delivered = options.mailer.configured;
      } catch (error) {
        process.stderr.write(`claim email failed: ${String(error)}\n`);
      }
      return c.html(<VerifyNoticePage email={address.trim()} sent delivered={delivered} />);
    } catch (error) {
      if (error instanceof EmailClaimError) {
        return c.html(<AddEmailPage error={error.message} email={address} />, 400);
      }
      throw error;
    }
  });
};

/** Registered behind the auth guard: these need a verified, signed-in account. */
export const registerCoinpayAccountRoutes = (
  app: Hono,
  options: Pick<CoinpayRouteOptions, 'config'> = {},
): void => {
  const config = options.config ?? (() => readCoinpayConfig());

  app.get('/account', async (c) => {
    const user = currentUser(c);
    if (user === null) return c.redirect('/login?next=%2Faccount');
    const identity = await coinpayIdentityForUser(user.id);
    return c.html(
      <AccountPage
        email={user.email}
        placeholderEmail={isPlaceholderEmail(user.email)}
        coinpayAvailable={config() !== null}
        coinpayEmail={identity?.email ?? null}
        linked={identity !== null}
        canDisconnect={identity !== null && (await hasPasswordLogin(user.id))}
        ok={c.req.query('ok')}
        error={c.req.query('err')}
      />,
    );
  });

  app.post('/account/coinpay/disconnect', async (c) => {
    if (!originAllowed(c)) return c.text('Bad origin', 403);
    const user = currentUser(c);
    if (user === null) return c.redirect('/login?next=%2Faccount');
    const result = await unlinkCoinpay(user.id);
    if (!result.ok) {
      const message =
        result.code === 'ONLY_SIGN_IN'
          ? 'CoinPay is the only way into this account, so it stays connected.'
          : 'CoinPay is not connected.';
      return c.redirect(`/account?err=${encodeURIComponent(message)}`);
    }
    return c.redirect(`/account?ok=${encodeURIComponent('CoinPay disconnected.')}`);
  });
};
