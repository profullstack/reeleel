/** @jsxImportSource hono/jsx */
import type { FC } from 'hono/jsx';

import { Layout } from './Layout.js';

const Problem: FC<{ message?: string | undefined }> = ({ message }) =>
  message === undefined ? null : (
    <p class="notice error" role="alert">
      {message}
    </p>
  );

export const LoginPage: FC<{
  error?: string | undefined;
  next?: string | undefined;
  email?: string | undefined;
  signupAllowed?: boolean;
}> = ({ error, next, email, signupAllowed = true }) => (
  <Layout title="Sign in">
    <h1>Sign in</h1>
    <Problem message={error} />
    <form method="post" action="/login" class="card narrow">
      <input type="hidden" name="next" value={next ?? '/'} />
      <div class="field">
        <label for="email">Email</label>
        <input id="email" name="email" type="email" autocomplete="username" required value={email ?? ''} />
      </div>
      <div class="field">
        <label for="password">Password</label>
        <input id="password" name="password" type="password" autocomplete="current-password" required />
      </div>
      <div class="actions">
        <button type="submit">Sign in</button>
        <a href="/forgot" class="muted">
          Forgot password?
        </a>
      </div>
    </form>
    {signupAllowed ? (
      <p class="muted">
        No account? <a href="/register">Create one</a>.
      </p>
    ) : null}
    <p class="muted">
      Running ReelEel on your own machine needs no account at all.
    </p>
  </Layout>
);

export const RegisterPage: FC<{
  error?: string | undefined;
  email?: string | undefined;
  minPasswordLength: number;
}> = ({ error, email, minPasswordLength }) => (
  <Layout title="Create account">
    <h1>Create account</h1>
    <Problem message={error} />
    <form method="post" action="/register" class="card narrow">
      <div class="field">
        <label for="email">Email</label>
        <input id="email" name="email" type="email" autocomplete="username" required value={email ?? ''} />
      </div>
      <div class="field">
        <label for="password">Password</label>
        <input
          id="password"
          name="password"
          type="password"
          autocomplete="new-password"
          required
          minlength={minPasswordLength}
        />
        <p class="muted">At least {minPasswordLength} characters. Length beats punctuation.</p>
      </div>
      <div class="actions">
        <button type="submit">Create account</button>
        <a href="/login" class="muted">
          I already have one
        </a>
      </div>
    </form>
    <p class="muted">
      ReelEel only stores your email and password. It never asks for anything about the
      athletes in your footage beyond what you choose to type.
    </p>
  </Layout>
);

export const VerifyNoticePage: FC<{ email: string; sent: boolean; delivered: boolean }> = ({
  email,
  sent,
  delivered,
}) => (
  <Layout title="Confirm your email">
    <h1>Confirm your email</h1>
    {sent ? <p class="notice">A new link is on its way to {email}.</p> : null}
    <p>
      We sent a confirmation link to <strong>{email}</strong>. Open it to finish setting up your
      account.
    </p>
    {delivered ? null : (
      <p class="notice error">
        This server has no email provider configured, so the link was written to the server log
        instead of being sent. Set <code>RESEND_API_KEY</code> to deliver it properly.
      </p>
    )}
    <form method="post" action="/verify/resend">
      <button type="submit">Send it again</button>
    </form>
    <p class="muted">
      <a href="/logout">Sign out</a>
    </p>
  </Layout>
);

export const ForgotPage: FC<{ sent?: boolean; error?: string | undefined }> = ({ sent, error }) => (
  <Layout title="Reset password">
    <h1>Reset password</h1>
    <Problem message={error} />
    {sent === true ? (
      // Deliberately identical whether or not the address exists — otherwise
      // this page becomes a way to discover who has an account.
      <p class="notice">
        If an account exists for that address, a reset link is on its way. The link expires in an
        hour.
      </p>
    ) : (
      <form method="post" action="/forgot" class="card narrow">
        <div class="field">
          <label for="email">Email</label>
          <input id="email" name="email" type="email" autocomplete="username" required />
        </div>
        <div class="actions">
          <button type="submit">Send reset link</button>
          <a href="/login" class="muted">
            Back to sign in
          </a>
        </div>
      </form>
    )}
  </Layout>
);

export const ResetPage: FC<{
  token: string;
  error?: string | undefined;
  minPasswordLength: number;
}> = ({ token, error, minPasswordLength }) => (
  <Layout title="Choose a new password">
    <h1>Choose a new password</h1>
    <Problem message={error} />
    <form method="post" action="/reset" class="card narrow">
      <input type="hidden" name="token" value={token} />
      <div class="field">
        <label for="password">New password</label>
        <input
          id="password"
          name="password"
          type="password"
          autocomplete="new-password"
          required
          minlength={minPasswordLength}
        />
      </div>
      <div class="actions">
        <button type="submit">Set password</button>
      </div>
    </form>
    <p class="muted">Setting a new password signs out every other session.</p>
  </Layout>
);

export const MessagePage: FC<{ title: string; body: string; linkHref?: string; linkText?: string }> = ({
  title,
  body,
  linkHref,
  linkText,
}) => (
  <Layout title={title}>
    <h1>{title}</h1>
    <p>{body}</p>
    {linkHref === undefined ? null : <p><a href={linkHref}>{linkText ?? 'Continue'}</a></p>}
  </Layout>
);
