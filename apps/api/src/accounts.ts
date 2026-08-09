import type { Context } from 'hono';

import type { ProjectScope } from '@reeleel/core';

import { getActor, presentedToken, readUserCookie } from './auth.js';
import type { AuthUser } from './auth.js';
import { readEmailConfig } from './email.js';
import { userForSession } from './users.js';

/**
 * Resolves the signed-in account from a session cookie or a bearer token.
 *
 * Native apps cannot rely on cookies the way a browser does, so the same
 * session secret is accepted in the Authorization header. It is the identical
 * credential either way — one session store, one revocation path.
 */
export const resolveUserFromRequest = async (c: Context): Promise<AuthUser | null> => {
  const candidates = [readUserCookie(c), presentedToken(c)].filter(
    (value): value is string => value !== null && value.length > 0,
  );

  for (const secret of candidates) {
    const user = await userForSession(secret);
    if (user !== null) {
      return { id: user.id, email: user.email, emailVerifiedAt: user.emailVerifiedAt };
    }
  }
  return null;
};

/**
 * How a request should be scoped when it reaches core.
 *
 * An account only ever sees its own projects. The shared service token is not
 * scoped — it belongs to whoever operates the deployment — and neither is a
 * local install with no accounts at all, which is the CLI's world.
 */
export const scopeFor = (c: Context): ProjectScope | undefined => {
  const actor = getActor(c);
  if (actor === null || actor.kind === 'admin') return undefined;
  return { ownerId: actor.user.id };
};

/** Owner to stamp on newly created projects, or undefined for unowned. */
export const ownerFor = (c: Context): string | undefined => {
  const actor = getActor(c);
  return actor !== null && actor.kind === 'user' ? actor.user.id : undefined;
};

/**
 * Verification is only enforced when email can actually be delivered.
 * Requiring it without a configured mailer would lock every account out of a
 * self-hosted install that never wanted email in the first place.
 */
export const requireVerifiedEmail = (env: NodeJS.ProcessEnv = process.env): boolean => {
  const override = env['REELEEL_REQUIRE_EMAIL_VERIFICATION'];
  if (override !== undefined && override.length > 0) {
    return ['1', 'true', 'yes', 'on'].includes(override.toLowerCase());
  }
  return readEmailConfig(env).apiKey !== null;
};

/** Whether new accounts may be created. */
export const signupAllowed = (env: NodeJS.ProcessEnv = process.env): boolean => {
  const value = env['REELEEL_ALLOW_SIGNUP'];
  if (value === undefined || value.length === 0) return true;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
};
