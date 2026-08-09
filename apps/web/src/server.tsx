/** @jsxImportSource hono/jsx */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import type { Context } from 'hono';

import {
  DEFAULT_SESSION_SECONDS,
  MIN_PASSWORD_LENGTH,
  UserError,
  baseUrl,
  checkPasswordStrength,
  clearUserCookie,
  clientKey,
  consumeToken,
  createApp as createApiApp,
  createMailer,
  createUser,
  createUserSession,
  currentUser,
  findUserByEmail,
  findUserById,
  issueToken,
  loginAttemptAllowed,
  markEmailVerified,
  originAllowed,
  readAuthConfig,
  readEmailConfig,
  readUserCookie,
  requireAuth,
  requireVerifiedEmail,
  resetEmail,
  resetLoginAttempts,
  resolveUserFromRequest,
  revokeSession,
  scopeFor,
  setPassword,
  setUserCookie,
  signupAllowed,
  verificationEmail,
  verifyLogin,
} from '@reeleel/api';
import type { AuthUser } from '@reeleel/api';
import {
  isReelEelError,
  listAthletes,
  listClips,
  listExports,
  listJobs,
  listMoments,
  listProjects,
  listSports,
  listVideos,
  newId,
  resolveProjectRoot,
  runChecks,
  summarizeProject,
  worstStatus,
} from '@reeleel/core';

import { registerActions } from './actions.js';
import { ForgotPage, LoginPage, MessagePage, RegisterPage, ResetPage, VerifyNoticePage } from './views/auth.js';
import { DoctorPage, ErrorPage, ProjectPage, ProjectsPage } from './views/pages.js';
import type { Flash } from './views/pages.js';
import { ICON_SVG, MANIFEST, SERVICE_WORKER } from './pwa.js';

const publicDir = path.join(fileURLToPath(new URL('../', import.meta.url)), 'public');

/**
 * Only same-origin relative paths are accepted as a post-login destination.
 * Anything else — including protocol-relative `//evil.example` — falls back to
 * the home page, so the login form cannot be used as an open redirect.
 */
export const safeRedirect = (value: unknown): string => {
  if (typeof value !== 'string' || value.length === 0) return '/';
  if (!value.startsWith('/') || value.startsWith('//')) return '/';
  return value;
};

const field = (body: Record<string, unknown>, name: string): string => {
  const value = body[name];
  return typeof value === 'string' ? value : '';
};

export const createWebApp = (): Hono => {
  const app = new Hono();
  const auth = readAuthConfig();
  const email = readEmailConfig();
  const mailer = createMailer(email);
  const verificationRequired = requireVerifiedEmail();

  /** Issues a fresh verification link and tries to deliver it. */
  const sendVerification = async (
    c: Context,
    user: { id: string; email: string },
  ): Promise<boolean> => {
    const token = await issueToken(user.id, 'verify');
    const link = `${baseUrl(email, c.req.url)}/verify?token=${encodeURIComponent(token)}`;
    try {
      await mailer.send({ to: user.email, ...verificationEmail(link) });
      return mailer.configured;
    } catch (error) {
      // A delivery failure must not lose the account that was just created.
      process.stderr.write(`verification email failed: ${String(error)}\n`);
      return false;
    }
  };

  app.route('/', createApiApp({ auth }));

  app.use(
    '/client.js',
    serveStatic({
      root: path.relative(process.cwd(), publicDir) || '.',
      rewriteRequestPath: () => '/client.js',
    }),
  );

  // ── Sign in ───────────────────────────────────────────────────────────────

  // ── Installable app shell (public: needed before sign-in) ─────────────────

  app.get('/manifest.webmanifest', (c) =>
    c.json(MANIFEST, 200, { 'cache-control': 'public, max-age=3600' }),
  );

  app.get('/icon.svg', (c) =>
    c.body(ICON_SVG, 200, {
      'content-type': 'image/svg+xml',
      'cache-control': 'public, max-age=86400',
    }),
  );

  app.get('/sw.js', (c) =>
    c.body(SERVICE_WORKER, 200, {
      'content-type': 'text/javascript',
      // A cached service worker is how an app gets stuck on an old version.
      'cache-control': 'no-cache',
    }),
  );

  app.get('/login', async (c) => {
    if ((await resolveUserFromRequest(c)) !== null) return c.redirect('/');
    return c.html(
      <LoginPage next={safeRedirect(c.req.query('next'))} signupAllowed={signupAllowed()} />,
    );
  });

  app.post('/login', async (c) => {
    if (!originAllowed(c)) return c.text('Bad origin', 403);

    const body = await c.req.parseBody();
    const next = safeRedirect(body['next']);
    const address = field(body, 'email');

    if (!loginAttemptAllowed(clientKey(c))) {
      return c.html(
        <LoginPage error="Too many attempts. Wait a few minutes." next={next} email={address} />,
        429,
      );
    }

    const user = await verifyLogin(address, field(body, 'password'));
    if (user === null) {
      // One message for both wrong-password and no-such-account: distinguishing
      // them turns the form into an account-existence oracle.
      return c.html(
        <LoginPage error="Those details do not match an account." next={next} email={address} />,
        401,
      );
    }

    resetLoginAttempts(clientKey(c));
    setUserCookie(c, await createUserSession(user.id), DEFAULT_SESSION_SECONDS);
    return c.redirect(next);
  });

  app.get('/logout', async (c) => {
    const secret = readUserCookie(c);
    if (secret !== null) await revokeSession(secret);
    clearUserCookie(c);
    return c.redirect('/login');
  });

  // ── Register ──────────────────────────────────────────────────────────────

  app.get('/register', async (c) => {
    if (!signupAllowed()) {
      return c.html(
        <MessagePage
          title="Registration is closed"
          body="This ReelEel instance is not accepting new accounts."
          linkHref="/login"
          linkText="Sign in"
        />,
        403,
      );
    }
    if ((await resolveUserFromRequest(c)) !== null) return c.redirect('/');
    return c.html(<RegisterPage minPasswordLength={MIN_PASSWORD_LENGTH} />);
  });

  app.post('/register', async (c) => {
    if (!originAllowed(c)) return c.text('Bad origin', 403);
    if (!signupAllowed()) return c.text('Registration is closed', 403);

    const body = await c.req.parseBody();
    const address = field(body, 'email');
    const password = field(body, 'password');

    if (!loginAttemptAllowed(`register:${clientKey(c)}`)) {
      return c.html(
        <RegisterPage
          error="Too many attempts. Wait a few minutes."
          email={address}
          minPasswordLength={MIN_PASSWORD_LENGTH}
        />,
        429,
      );
    }

    const strength = checkPasswordStrength(password);
    if (!strength.ok) {
      return c.html(
        <RegisterPage
          error={strength.reason ?? 'Choose a stronger password.'}
          email={address}
          minPasswordLength={MIN_PASSWORD_LENGTH}
        />,
        400,
      );
    }

    try {
      const user = await createUser({ email: address, password });
      const delivered = await sendVerification(c, user);
      setUserCookie(c, await createUserSession(user.id), DEFAULT_SESSION_SECONDS);
      return c.html(<VerifyNoticePage email={user.email} sent={false} delivered={delivered} />);
    } catch (error) {
      if (error instanceof UserError) {
        return c.html(
          <RegisterPage
            error={error.message}
            email={address}
            minPasswordLength={MIN_PASSWORD_LENGTH}
          />,
          409,
        );
      }
      throw error;
    }
  });

  // ── Email verification ────────────────────────────────────────────────────

  app.get('/verify', async (c) => {
    const token = c.req.query('token') ?? '';
    const userId = await consumeToken(token, 'verify');
    if (userId === null) {
      return c.html(
        <MessagePage
          title="That link has expired"
          body="Verification links last 24 hours and can only be used once. Sign in to request a new one."
          linkHref="/login"
          linkText="Sign in"
        />,
        400,
      );
    }
    await markEmailVerified(userId);
    return c.html(
      <MessagePage
        title="Email confirmed"
        body="Your address is confirmed and your account is ready."
        linkHref="/"
        linkText="Go to your projects"
      />,
    );
  });

  app.post('/verify/resend', async (c) => {
    if (!originAllowed(c)) return c.text('Bad origin', 403);

    const user = await resolveUserFromRequest(c);
    if (user === null) return c.redirect('/login');
    if (user.emailVerifiedAt !== null) return c.redirect('/');

    const delivered = await sendVerification(c, user);
    return c.html(<VerifyNoticePage email={user.email} sent delivered={delivered} />);
  });

  // ── Password reset ────────────────────────────────────────────────────────

  app.get('/forgot', (c) => c.html(<ForgotPage />));

  app.post('/forgot', async (c) => {
    if (!originAllowed(c)) return c.text('Bad origin', 403);

    const body = await c.req.parseBody();
    const address = field(body, 'email');

    if (!loginAttemptAllowed(`forgot:${clientKey(c)}`)) {
      return c.html(<ForgotPage error="Too many attempts. Wait a few minutes." />, 429);
    }

    // Always report the same outcome, whether or not the account exists.
    const user = await findUserByEmail(address);
    if (user !== null) {
      const token = await issueToken(user.id, 'reset');
      const link = `${baseUrl(email, c.req.url)}/reset?token=${encodeURIComponent(token)}`;
      try {
        await mailer.send({ to: user.email, ...resetEmail(link) });
      } catch (error) {
        process.stderr.write(`reset email failed: ${String(error)}\n`);
      }
    }
    return c.html(<ForgotPage sent />);
  });

  app.get('/reset', (c) => {
    const token = c.req.query('token') ?? '';
    if (token.length === 0) return c.redirect('/forgot');
    return c.html(<ResetPage token={token} minPasswordLength={MIN_PASSWORD_LENGTH} />);
  });

  app.post('/reset', async (c) => {
    if (!originAllowed(c)) return c.text('Bad origin', 403);

    const body = await c.req.parseBody();
    const token = field(body, 'token');
    const password = field(body, 'password');

    const strength = checkPasswordStrength(password);
    if (!strength.ok) {
      return c.html(
        <ResetPage
          token={token}
          error={strength.reason ?? 'Choose a stronger password.'}
          minPasswordLength={MIN_PASSWORD_LENGTH}
        />,
        400,
      );
    }

    const userId = await consumeToken(token, 'reset');
    if (userId === null) {
      return c.html(
        <MessagePage
          title="That link has expired"
          body="Reset links last an hour and can only be used once."
          linkHref="/forgot"
          linkText="Request another"
        />,
        400,
      );
    }

    // setPassword revokes every existing session, including any the attacker
    // might hold, so the reset genuinely takes the account back.
    await setPassword(userId, password);
    const user = await findUserById(userId);
    if (user !== null && user.emailVerifiedAt === null) await markEmailVerified(userId);

    clearUserCookie(c);
    setUserCookie(c, await createUserSession(userId), DEFAULT_SESSION_SECONDS);
    return c.redirect('/');
  });

  // ── Everything below needs an account ─────────────────────────────────────

  app.use(
    '*',
    requireAuth({
      config: auth,
      resolveUser: resolveUserFromRequest,
      requireVerifiedEmail: verificationRequired,
      onUnauthorized: (c) => {
        const url = new URL(c.req.url);
        return c.redirect(`/login?next=${encodeURIComponent(`${url.pathname}${url.search}`)}`);
      },
      onUnverified: (c, user: AuthUser) =>
        c.html(<VerifyNoticePage email={user.email} sent={false} delivered={mailer.configured} />, 403),
    }),
  );

  registerActions(app);

  /** `?ok=` / `?err=` set by a redirect after a form post. */
  const flashOf = (c: Context): Flash => ({
    ok: c.req.query('ok'),
    err: c.req.query('err'),
  });

  app.get('/', async (c) => {
    try {
      return c.html(
        <ProjectsPage
          projects={await listProjects(scopeFor(c))}
          sports={listSports().map((sport) => ({ id: sport.id, name: sport.name }))}
          flash={flashOf(c)}
        />,
      );
    } catch (error) {
      return c.html(<ErrorPage message={String(error)} />, 500);
    }
  });

  app.get('/doctor', async (c) => {
    const checks = await runChecks();
    return c.html(<DoctorPage checks={checks} status={worstStatus(checks)} />);
  });

  app.get('/projects/:ref', async (c) => {
    try {
      const ref = c.req.param('ref');
      if (ref === undefined) return c.html(<ErrorPage message="No project given." />, 400);

      const root = await resolveProjectRoot(decodeURIComponent(ref), scopeFor(c));
      const [project, videos, athletes, moments, clips, jobs, exports] = await Promise.all([
        summarizeProject(root),
        listVideos(root),
        listAthletes(root),
        listMoments(root),
        listClips(root),
        listJobs(root, { limit: 10 }),
        listExports(root),
      ]);
      return c.html(
        <ProjectPage
          project={project}
          videos={videos}
          athletes={athletes}
          moments={moments}
          clips={clips}
          jobs={jobs}
          exports={exports}
          flash={flashOf(c)}
        />,
      );
    } catch (error) {
      if (isReelEelError(error)) {
        return c.html(<ErrorPage message={error.message} hint={error.hint} />, 404);
      }
      return c.html(<ErrorPage message={String(error)} />, 500);
    }
  });

  app.notFound((c) => c.html(<ErrorPage message="No such page." />, 404));

  /**
   * Anything that escapes a handler. Hono's default is a bare 500 with no log
   * line at all, which is how a server-side fault becomes "it just didn't
   * work" for the user *and* for whoever has to diagnose it afterwards. Every
   * failure now gets an id that appears both on screen and next to the stack
   * trace in the log.
   */
  app.onError((error, c) => {
    const id = newId('err');
    process.stderr.write(
      `[error ${id}] ${c.req.method} ${c.req.path}\n${error.stack ?? String(error)}\n`,
    );
    if ((c.req.header('accept') ?? '').includes('application/json')) {
      return c.json({ ok: false, code: 'UNKNOWN', error: error.message, errorId: id }, 500);
    }
    return c.html(
      <ErrorPage
        message={error.message}
        hint={`Reference ${id} — the full details are in the server log.`}
      />,
      500,
    );
  });

  return app;
};

export const clientBundleExists = (): boolean => existsSync(path.join(publicDir, 'client.js'));
export { currentUser };
