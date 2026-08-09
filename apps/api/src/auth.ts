import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import type { Context, MiddlewareHandler, Next } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';

/**
 * Authentication for the hosted surfaces (API + web). The CLI and desktop app
 * talk to @reeleel/core directly and are never touched by this.
 *
 * The PRD is explicit that no account is required for local desktop use, so the
 * rule is about *exposure*, not about having a login:
 *
 *   - REELEEL_AUTH_TOKEN set  → every route except the public ones needs it.
 *   - not set, on loopback    → open. This is someone running it on their own
 *                               machine, which is the whole point of the product.
 *   - not set, bound publicly → refuse to start (see `assertAuthConfigured`).
 *
 * That last case is the one that matters: a deployment that forgets to set a
 * token should fail loudly, not serve a delete-capable API to the internet.
 */

/** Admin/service token browser session (stateless HMAC). */
export const SESSION_COOKIE = 'reeleel_session';
/** Account session (opaque secret; the row lives in the database). */
export const USER_COOKIE = 'reeleel_user';
const SESSION_VERSION = 'v1';
const DEFAULT_SESSION_SECONDS = 60 * 60 * 24 * 7;

/** The signed-in account, when accounts are in use. */
export interface AuthUser {
  id: string;
  email: string;
  emailVerifiedAt: string | null;
}

/** Who is making a request: an account, or the shared service token. */
export type Actor = { kind: 'user'; user: AuthUser } | { kind: 'admin' };

export interface AuthConfig {
  /** Shared secret. `null` means no token configured. */
  token: string | null;
  sessionSeconds: number;
}

export const readAuthConfig = (env: NodeJS.ProcessEnv = process.env): AuthConfig => {
  const token = env['REELEEL_AUTH_TOKEN'];
  const ttl = Number(env['REELEEL_SESSION_SECONDS'] ?? DEFAULT_SESSION_SECONDS);
  return {
    token: token !== undefined && token.length > 0 ? token : null,
    sessionSeconds: Number.isFinite(ttl) && ttl > 0 ? ttl : DEFAULT_SESSION_SECONDS,
  };
};

export const isAuthEnabled = (config: AuthConfig = readAuthConfig()): boolean =>
  config.token !== null;

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost', '0:0:0:0:0:0:0:1']);

export const isLoopbackHost = (host: string): boolean => LOOPBACK.has(host.trim().toLowerCase());

export class AuthConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthConfigError';
  }
}

/**
 * Fail-closed guard for server entry points. Throws when the process is about
 * to listen on a non-loopback interface without a token configured.
 */
export const assertAuthConfigured = (host: string, config: AuthConfig = readAuthConfig()): void => {
  if (isAuthEnabled(config) || isLoopbackHost(host)) return;
  throw new AuthConfigError(
    `Refusing to listen on ${host} without authentication.\n` +
      'This server can read, modify and delete local project directories.\n\n' +
      'Set REELEEL_AUTH_TOKEN to a long random string, for example:\n' +
      `  REELEEL_AUTH_TOKEN=${generateToken()}\n\n` +
      'Or bind to loopback (HOST=127.0.0.1) to run it only on this machine.',
  );
};

export const generateToken = (): string => randomBytes(32).toString('base64url');

/** Constant-time comparison that does not leak length through early return. */
export const safeEqual = (a: string, b: string): boolean => {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) {
    // Still burn a comparison so a length mismatch is not measurably faster.
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
};

const sign = (payload: string, token: string): string =>
  createHmac('sha256', token).update(payload).digest('base64url');

/** `v1.<expiry>.<hmac>` — the token itself is never stored in the cookie. */
export const createSession = (config: AuthConfig, now = Date.now()): string => {
  if (config.token === null) throw new AuthConfigError('Cannot create a session without a token.');
  const expiresAt = Math.floor(now / 1000) + config.sessionSeconds;
  const payload = `${SESSION_VERSION}.${expiresAt}`;
  return `${payload}.${sign(payload, config.token)}`;
};

export const verifySession = (value: string, config: AuthConfig, now = Date.now()): boolean => {
  if (config.token === null) return false;
  const parts = value.split('.');
  if (parts.length !== 3) return false;

  const [version, expiresAt, signature] = parts;
  if (version !== SESSION_VERSION || expiresAt === undefined || signature === undefined) {
    return false;
  }

  const expiry = Number(expiresAt);
  if (!Number.isFinite(expiry) || expiry * 1000 <= now) return false;

  return safeEqual(signature, sign(`${version}.${expiresAt}`, config.token));
};

/** Bearer header, custom header, or `?token=` for quick curl checks. */
export const presentedToken = (c: Context): string | null => {
  const authorization = c.req.header('authorization');
  if (authorization !== undefined) {
    const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
    if (match?.[1] !== undefined) return match[1];
  }
  const header = c.req.header('x-reeleel-token');
  if (header !== undefined && header.length > 0) return header;
  const query = c.req.query('token');
  if (query !== undefined && query.length > 0) return query;
  return null;
};

export const isAuthenticated = (c: Context, config: AuthConfig): boolean => {
  if (config.token === null) return true;

  const presented = presentedToken(c);
  if (presented !== null && safeEqual(presented, config.token)) return true;

  const cookie = getCookie(c, SESSION_COOKIE);
  return cookie !== undefined && verifySession(cookie, config);
};

export const startSession = (c: Context, config: AuthConfig): void => {
  setCookie(c, SESSION_COOKIE, createSession(config), {
    httpOnly: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: config.sessionSeconds,
    // Only mark Secure over https, or the cookie is dropped on plain-http local use.
    secure: new URL(c.req.url).protocol === 'https:',
  });
};

export const endSession = (c: Context): void => {
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
};

const secureCookie = (c: Context): boolean => new URL(c.req.url).protocol === 'https:';

/** Account session cookie. The value is an opaque secret; the row is in the DB. */
export const setUserCookie = (c: Context, secret: string, maxAgeSeconds: number): void => {
  setCookie(c, USER_COOKIE, secret, {
    httpOnly: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: maxAgeSeconds,
    secure: secureCookie(c),
  });
};

export const readUserCookie = (c: Context): string | null => getCookie(c, USER_COOKIE) ?? null;

export const clearUserCookie = (c: Context): void => {
  deleteCookie(c, USER_COOKIE, { path: '/' });
};

/**
 * Rejects cross-site form posts. The session cookies are SameSite=Lax, which
 * already stops a cross-site POST from carrying them, so this is defence in
 * depth against a browser that does not enforce that.
 */
export const originAllowed = (c: Context): boolean => {
  const origin = c.req.header('origin');
  if (origin === undefined) return true; // Non-browser client, or same-origin GET.
  try {
    return new URL(origin).host === new URL(c.req.url).host;
  } catch {
    return false;
  }
};

/**
 * Routes that must stay reachable without credentials.
 * `/api/health` is deliberately public: platform healthchecks are unauthenticated,
 * and it discloses nothing but a version string.
 */
export const PUBLIC_PATHS = new Set([
  '/api/health',
  '/login',
  '/logout',
  '/register',
  '/verify',
  '/verify/resend',
  '/forgot',
  '/reset',
  '/client.js',
  // Installable-app assets. A browser fetches these before anyone signs in,
  // and none of them disclose anything.
  '/manifest.webmanifest',
  '/sw.js',
  '/icon.svg',
]);

export const isPublicPath = (path: string): boolean => PUBLIC_PATHS.has(path);

export interface AuthMiddlewareOptions {
  config?: AuthConfig;
  /** Called instead of a JSON 401 — the web app renders a login page. */
  onUnauthorized?: (c: Context) => Response | Promise<Response>;
  /**
   * Resolves a signed-in account from the request. Injected rather than
   * imported so this module stays free of database access and is unit-testable
   * without one.
   */
  resolveUser?: (c: Context) => Promise<AuthUser | null>;
  /** Block accounts that have not confirmed their address. */
  requireVerifiedEmail?: boolean;
  onUnverified?: (c: Context, user: AuthUser) => Response | Promise<Response>;
}

/** The actor for the current request, set by `requireAuth`. */
export const getActor = (c: Context): Actor | null =>
  (c.get('actor') as Actor | undefined) ?? null;

export const currentUser = (c: Context): AuthUser | null => {
  const actor = getActor(c);
  return actor !== null && actor.kind === 'user' ? actor.user : null;
};

export const requireAuth = (options: AuthMiddlewareOptions = {}): MiddlewareHandler => {
  const config = options.config ?? readAuthConfig();

  return async (c: Context, next: Next) => {
    const path = new URL(c.req.url).pathname;

    // Accounts are resolved even on public paths and even when the shared token
    // is absent, so pages can show who is signed in.
    const user = options.resolveUser === undefined ? null : await options.resolveUser(c);
    if (user !== null) c.set('actor', { kind: 'user', user } satisfies Actor);

    if (isPublicPath(path)) {
      await next();
      return;
    }

    if (user !== null) {
      if (options.requireVerifiedEmail === true && user.emailVerifiedAt === null) {
        if (options.onUnverified !== undefined) return options.onUnverified(c, user);
        return c.json(
          {
            ok: false,
            code: 'EMAIL_UNVERIFIED',
            error: 'Confirm your email address to continue.',
          },
          403,
        );
      }
      await next();
      return;
    }

    // The shared token is a service credential: it belongs to whoever runs the
    // deployment, so it is not scoped to any account's projects.
    if (isAuthEnabled(config) && isAuthenticated(c, config)) {
      c.set('actor', { kind: 'admin' } satisfies Actor);
      await next();
      return;
    }

    // No token configured and no account: this is a local, single-user install.
    if (!isAuthEnabled(config) && options.resolveUser === undefined) {
      await next();
      return;
    }

    if (options.onUnauthorized !== undefined) return options.onUnauthorized(c);

    return c.json(
      {
        ok: false,
        code: 'UNAUTHORIZED',
        error: 'Authentication required.',
        hint: 'Sign in at /login, or send `Authorization: Bearer <REELEEL_AUTH_TOKEN>`.',
      },
      401,
      { 'WWW-Authenticate': 'Bearer realm="ReelEel"' },
    );
  };
};

/**
 * Small in-memory throttle on login attempts. Not a substitute for a real rate
 * limiter, but enough that a shared secret cannot be brute forced over HTTP.
 */
const attempts = new Map<string, { count: number; resetAt: number }>();
const MAX_ATTEMPTS = 10;
const WINDOW_MS = 15 * 60 * 1000;

export const loginAttemptAllowed = (key: string, now = Date.now()): boolean => {
  const entry = attempts.get(key);
  if (entry === undefined || entry.resetAt <= now) {
    attempts.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return true;
  }
  entry.count += 1;
  return entry.count <= MAX_ATTEMPTS;
};

export const resetLoginAttempts = (key?: string): void => {
  if (key === undefined) attempts.clear();
  else attempts.delete(key);
};

export const clientKey = (c: Context): string =>
  c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ??
  c.req.header('x-real-ip') ??
  'unknown';
