import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  AuthConfigError,
  SESSION_COOKIE,
  assertAuthConfigured,
  createSession,
  generateToken,
  isAuthEnabled,
  isLoopbackHost,
  isPublicPath,
  loginAttemptAllowed,
  readAuthConfig,
  requireAuth,
  resetLoginAttempts,
  safeEqual,
  verifySession,
} from './auth.js';
import type { AuthConfig } from './auth.js';

const TOKEN = 'test-token-abcdefghijklmnopqrstuvwxyz';
const config: AuthConfig = { token: TOKEN, sessionSeconds: 3600 };
const openConfig: AuthConfig = { token: null, sessionSeconds: 3600 };

const guardedApp = (auth: AuthConfig): Hono => {
  const app = new Hono();
  app.use('*', requireAuth({ config: auth }));
  app.get('/api/health', (c) => c.json({ ok: true }));
  app.get('/api/projects', (c) => c.json({ ok: true, projects: [] }));
  app.delete('/api/projects/:id', (c) => c.json({ ok: true }));
  return app;
};

describe('readAuthConfig', () => {
  it('treats an unset or empty token as no auth', () => {
    expect(readAuthConfig({}).token).toBeNull();
    expect(readAuthConfig({ REELEEL_AUTH_TOKEN: '' }).token).toBeNull();
    expect(isAuthEnabled(readAuthConfig({}))).toBe(false);
  });

  it('enables auth when a token is present', () => {
    const parsed = readAuthConfig({ REELEEL_AUTH_TOKEN: TOKEN });
    expect(parsed.token).toBe(TOKEN);
    expect(isAuthEnabled(parsed)).toBe(true);
  });

  it('falls back to a sane session length when given nonsense', () => {
    expect(readAuthConfig({ REELEEL_SESSION_SECONDS: 'abc' }).sessionSeconds).toBeGreaterThan(0);
    expect(readAuthConfig({ REELEEL_SESSION_SECONDS: '-5' }).sessionSeconds).toBeGreaterThan(0);
  });
});

describe('assertAuthConfigured', () => {
  it('refuses to listen publicly without a token', () => {
    expect(() => assertAuthConfigured('0.0.0.0', openConfig)).toThrow(AuthConfigError);
    expect(() => assertAuthConfigured('192.168.1.10', openConfig)).toThrow(AuthConfigError);
  });

  it('allows loopback without a token — local-first use needs no account', () => {
    for (const host of ['127.0.0.1', 'localhost', '::1']) {
      expect(() => assertAuthConfigured(host, openConfig)).not.toThrow();
    }
  });

  it('allows any host once a token is configured', () => {
    expect(() => assertAuthConfigured('0.0.0.0', config)).not.toThrow();
  });

  it('suggests a usable token in its error message', () => {
    try {
      assertAuthConfigured('0.0.0.0', openConfig);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as Error).message).toContain('REELEEL_AUTH_TOKEN=');
    }
  });
});

describe('isLoopbackHost', () => {
  it('recognises loopback spellings and rejects everything else', () => {
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('LOCALHOST')).toBe(true);
    expect(isLoopbackHost('::1')).toBe(true);
    expect(isLoopbackHost('0.0.0.0')).toBe(false);
    expect(isLoopbackHost('10.0.0.5')).toBe(false);
  });
});

describe('safeEqual', () => {
  it('compares equal strings as equal', () => {
    expect(safeEqual(TOKEN, TOKEN)).toBe(true);
  });

  it('rejects different values, including different lengths', () => {
    expect(safeEqual(TOKEN, `${TOKEN}x`)).toBe(false);
    expect(safeEqual(TOKEN, 'short')).toBe(false);
    expect(safeEqual('', TOKEN)).toBe(false);
  });
});

describe('sessions', () => {
  it('issues a session that verifies with the same token', () => {
    const session = createSession(config);
    expect(verifySession(session, config)).toBe(true);
  });

  it('never embeds the token in the cookie', () => {
    expect(createSession(config)).not.toContain(TOKEN);
  });

  it('rejects a tampered signature or expiry', () => {
    const session = createSession(config);
    const [version, expiry, signature] = session.split('.');

    expect(verifySession(`${version}.${expiry}.${signature}x`, config)).toBe(false);
    // Extending the expiry invalidates the signature over it.
    expect(verifySession(`${version}.${Number(expiry) + 10_000}.${signature}`, config)).toBe(false);
  });

  it('rejects a session signed with a different token', () => {
    const session = createSession(config);
    expect(verifySession(session, { token: 'another-token', sessionSeconds: 3600 })).toBe(false);
  });

  it('rejects an expired session', () => {
    const session = createSession(config, Date.now() - 7200 * 1000);
    expect(verifySession(session, config)).toBe(false);
  });

  it('rejects malformed values', () => {
    for (const value of ['', 'garbage', 'v1.123', 'v2.123.abc', '...']) {
      expect(verifySession(value, config)).toBe(false);
    }
  });

  it('cannot create a session when auth is disabled', () => {
    expect(() => createSession(openConfig)).toThrow(AuthConfigError);
  });
});

describe('requireAuth middleware', () => {
  it('lets everything through when no token is configured', async () => {
    const app = guardedApp(openConfig);
    expect((await app.request('/api/projects')).status).toBe(200);
  });

  it('rejects unauthenticated requests with 401 JSON', async () => {
    const app = guardedApp(config);
    const response = await app.request('/api/projects');

    expect(response.status).toBe(401);
    expect(response.headers.get('WWW-Authenticate')).toContain('Bearer');
    const body = (await response.json()) as { ok: boolean; code: string };
    expect(body.ok).toBe(false);
    expect(body.code).toBe('UNAUTHORIZED');
  });

  it('protects destructive routes', async () => {
    const app = guardedApp(config);
    expect((await app.request('/api/projects/abc', { method: 'DELETE' })).status).toBe(401);
  });

  it('keeps /api/health public so platform healthchecks pass', async () => {
    const app = guardedApp(config);
    expect((await app.request('/api/health')).status).toBe(200);
    expect(isPublicPath('/api/health')).toBe(true);
  });

  it('accepts a bearer token', async () => {
    const app = guardedApp(config);
    const response = await app.request('/api/projects', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(response.status).toBe(200);
  });

  it('accepts the x-reeleel-token header and a ?token= query', async () => {
    const app = guardedApp(config);
    expect(
      (await app.request('/api/projects', { headers: { 'x-reeleel-token': TOKEN } })).status,
    ).toBe(200);
    expect((await app.request(`/api/projects?token=${TOKEN}`)).status).toBe(200);
  });

  it('rejects a wrong or empty token', async () => {
    const app = guardedApp(config);
    for (const header of ['Bearer wrong', 'Bearer ', 'Basic abc']) {
      expect((await app.request('/api/projects', { headers: { authorization: header } })).status).toBe(
        401,
      );
    }
  });

  it('accepts a valid session cookie', async () => {
    const app = guardedApp(config);
    const response = await app.request('/api/projects', {
      headers: { cookie: `${SESSION_COOKIE}=${createSession(config)}` },
    });
    expect(response.status).toBe(200);
  });

  it('rejects a forged session cookie', async () => {
    const app = guardedApp(config);
    const forged = createSession({ token: 'attacker-token', sessionSeconds: 3600 });
    const response = await app.request('/api/projects', {
      headers: { cookie: `${SESSION_COOKIE}=${forged}` },
    });
    expect(response.status).toBe(401);
  });

  it('calls the custom unauthorized handler when given one', async () => {
    const app = new Hono();
    app.use('*', requireAuth({ config, onUnauthorized: (c) => c.redirect('/login') }));
    app.get('/', (c) => c.text('secret'));

    const response = await app.request('/');
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/login');
  });
});

describe('login throttling', () => {
  beforeEach(() => resetLoginAttempts());

  it('allows a burst then blocks', () => {
    for (let i = 0; i < 10; i += 1) {
      expect(loginAttemptAllowed('1.2.3.4')).toBe(true);
    }
    expect(loginAttemptAllowed('1.2.3.4')).toBe(false);
  });

  it('tracks clients independently', () => {
    for (let i = 0; i < 11; i += 1) loginAttemptAllowed('1.2.3.4');
    expect(loginAttemptAllowed('5.6.7.8')).toBe(true);
  });

  it('recovers after the window passes', () => {
    const start = Date.now();
    for (let i = 0; i < 11; i += 1) loginAttemptAllowed('1.2.3.4', start);
    expect(loginAttemptAllowed('1.2.3.4', start)).toBe(false);
    expect(loginAttemptAllowed('1.2.3.4', start + 16 * 60 * 1000)).toBe(true);
  });
});

describe('generateToken', () => {
  it('produces a long, url-safe, non-repeating token', () => {
    const a = generateToken();
    const b = generateToken();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(43);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});
