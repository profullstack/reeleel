import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { execute, get, globalDb } from '@reeleel/core';

import { findUserById, isValidEmail, normalizeEmail } from './users.js';
import type { User } from './users.js';

/**
 * Sign in with CoinPay.
 *
 * CoinPay is the fleet's master account. An account here is bound to a CoinPay
 * identity by its `sub` and nothing else (the STANDING rule):
 *
 * - a CoinPay login never signs into an existing account because the emails
 *   match; CoinPay does not verify addresses (`email_verified` is always false);
 * - the CoinPay email is never written to `users.email`, which is unique and
 *   gates the app once verified. It is kept on the identity row as contact info;
 * - CoinPay is linked to an existing account only from inside that account.
 */

const nowIso = (): string => new Date().toISOString();
const newId = (prefix: string): string => `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

/** Marks an account that has no password: `verifyPassword` can never match it. */
export const NO_PASSWORD = 'coinpay-only';

/** Accounts created by CoinPay carry an address that cannot receive mail. */
export const PLACEHOLDER_DOMAIN = 'coinpay.invalid';

export const isPlaceholderEmail = (email: string): boolean =>
  normalizeEmail(email).endsWith(`@${PLACEHOLDER_DOMAIN}`);

const placeholderEmailFor = (sub: string): string =>
  `coinpay-${sha256(sub).slice(0, 20)}@${PLACEHOLDER_DOMAIN}`;

export interface CoinpayConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

/** Null when the deployment has no CoinPay client; the button is then hidden. */
export const readCoinpayConfig = (env: NodeJS.ProcessEnv = process.env): CoinpayConfig | null => {
  const clientId = env['COINPAY_OAUTH_CLIENT_ID'] ?? '';
  const clientSecret = env['COINPAY_OAUTH_CLIENT_SECRET'] ?? '';
  if (clientId.length === 0 || clientSecret.length === 0) return null;
  const site = (env['REELEEL_PUBLIC_URL'] ?? 'https://reeleel.com').replace(/\/+$/, '');
  return { clientId, clientSecret, redirectUri: `${site}/api/v1/coinpay/oauth/callback` };
};

// ── Authorization requests in flight ────────────────────────────────────────

export const PENDING_TTL_SECONDS = 10 * 60;

export interface PendingSignIn {
  verifier: string;
  nonce: string;
  next: string;
  /** Set when a signed-in account is connecting CoinPay rather than signing in. */
  linkUserId: string | null;
}

/** Stored under the hash of `state`, so the table alone cannot finish a login. */
export const savePending = async (state: string, pending: PendingSignIn): Promise<void> => {
  const db = await globalDb();
  await execute(db, 'DELETE FROM coinpay_pending WHERE expires_at <= ?', [nowIso()]);
  await execute(
    db,
    `INSERT INTO coinpay_pending (id, verifier, nonce, next_path, link_user_id, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      sha256(state),
      pending.verifier,
      pending.nonce,
      pending.next,
      pending.linkUserId,
      new Date(Date.now() + PENDING_TTL_SECONDS * 1000).toISOString(),
      nowIso(),
    ],
  );
};

/** Single use: the row is deleted by whichever request reaches it first. */
export const takePending = async (state: string): Promise<PendingSignIn | null> => {
  if (state.length === 0) return null;
  const db = await globalDb();
  const id = sha256(state);
  const row = await get<{
    verifier: string;
    nonce: string;
    next_path: string;
    link_user_id: string | null;
    expires_at: string;
  }>(db, 'SELECT verifier, nonce, next_path, link_user_id, expires_at FROM coinpay_pending WHERE id = ?', [id]);
  if (row === undefined) return null;
  const deleted = await execute(db, 'DELETE FROM coinpay_pending WHERE id = ?', [id]);
  if (deleted.rowsAffected !== 1) return null;
  if (new Date(row.expires_at).getTime() <= Date.now()) return null;
  return {
    verifier: row.verifier,
    nonce: row.nonce,
    next: row.next_path,
    linkUserId: row.link_user_id,
  };
};

// ── Identities ──────────────────────────────────────────────────────────────

export interface CoinpayIdentity {
  sub: string;
  userId: string;
  email: string | null;
  name: string | null;
  createdAt: string;
}

interface IdentityRow {
  sub: string;
  user_id: string;
  email: string | null;
  name: string | null;
  created_at: string;
}

const toIdentity = (row: IdentityRow): CoinpayIdentity => ({
  sub: row.sub,
  userId: row.user_id,
  email: row.email,
  name: row.name,
  createdAt: row.created_at,
});

export const findCoinpayIdentity = async (sub: string): Promise<CoinpayIdentity | null> => {
  const db = await globalDb();
  const row = await get<IdentityRow>(db, 'SELECT * FROM coinpay_identities WHERE sub = ?', [sub]);
  return row === undefined ? null : toIdentity(row);
};

export const coinpayIdentityForUser = async (userId: string): Promise<CoinpayIdentity | null> => {
  const db = await globalDb();
  const row = await get<IdentityRow>(db, 'SELECT * FROM coinpay_identities WHERE user_id = ?', [
    userId,
  ]);
  return row === undefined ? null : toIdentity(row);
};

export interface CoinpayProfile {
  sub: string;
  email: string | null;
  name: string | null;
}

export type CoinpaySignInResult =
  | { ok: true; user: User; created: boolean; linked: boolean }
  | { ok: false; code: 'LINKED_ELSEWHERE' | 'ALREADY_LINKED' | 'SIGNUP_CLOSED' | 'DISABLED' | 'NO_USER' };

/** Contact info only: trimmed, shape-checked, never used to find an account. */
const contactEmail = (email: string | null): string | null =>
  email !== null && isValidEmail(email) ? email.trim() : null;

const insertIdentity = async (userId: string, profile: CoinpayProfile): Promise<void> => {
  const db = await globalDb();
  await execute(
    db,
    `INSERT INTO coinpay_identities (sub, user_id, email, name, created_at, last_login_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [profile.sub, userId, contactEmail(profile.email), profile.name, nowIso(), nowIso()],
  );
};

/**
 * Resolves a finished CoinPay authorization to a local account.
 *
 * - `linkUserId` set (Connect CoinPay, signed in): bind the sub to that account.
 * - sub already bound: sign into the bound account.
 * - otherwise: a new account bound to the sub, with a placeholder address,
 *   whatever the CoinPay email is. Never an existing account by email.
 */
export const signInWithCoinpay = async (
  profile: CoinpayProfile,
  options: { linkUserId: string | null; signupAllowed: boolean },
): Promise<CoinpaySignInResult> => {
  const existing = await findCoinpayIdentity(profile.sub);
  const db = await globalDb();

  if (options.linkUserId !== null) {
    const target = await findUserById(options.linkUserId);
    if (target === null) return { ok: false, code: 'NO_USER' };
    if (existing !== null) {
      return existing.userId === target.id
        ? { ok: true, user: target, created: false, linked: false }
        : { ok: false, code: 'LINKED_ELSEWHERE' };
    }
    if ((await coinpayIdentityForUser(target.id)) !== null) return { ok: false, code: 'ALREADY_LINKED' };
    await insertIdentity(target.id, profile);
    return { ok: true, user: target, created: false, linked: true };
  }

  if (existing !== null) {
    const user = await findUserById(existing.userId);
    if (user === null) return { ok: false, code: 'NO_USER' };
    if (user.status !== 'active') return { ok: false, code: 'DISABLED' };
    await execute(db, 'UPDATE coinpay_identities SET last_login_at = ?, email = ?, name = ? WHERE sub = ?', [
      nowIso(),
      contactEmail(profile.email),
      profile.name,
      profile.sub,
    ]);
    return { ok: true, user, created: false, linked: false };
  }

  if (!options.signupAllowed) return { ok: false, code: 'SIGNUP_CLOSED' };

  const id = newId('usr');
  const email = placeholderEmailFor(profile.sub);
  const timestamp = nowIso();
  await execute(
    db,
    `INSERT INTO users
       (id, email, email_normalized, password_hash, display_name, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
    [id, email, normalizeEmail(email), NO_PASSWORD, profile.name?.trim() || null, timestamp, timestamp],
  );
  await insertIdentity(id, profile);
  const user = await findUserById(id);
  if (user === null) throw new Error('User vanished immediately after creation.');
  return { ok: true, user, created: true, linked: true };
};

/** True when the account can still sign in with its email and a password. */
export const hasPasswordLogin = async (userId: string): Promise<boolean> => {
  const db = await globalDb();
  const row = await get<{ email: string; password_hash: string }>(
    db,
    'SELECT email, password_hash FROM users WHERE id = ?',
    [userId],
  );
  return row !== undefined && row.password_hash !== NO_PASSWORD && !isPlaceholderEmail(row.email);
};

export type UnlinkResult = { ok: true } | { ok: false; code: 'NOT_LINKED' | 'ONLY_SIGN_IN' };

/** Refused when CoinPay is the only way into the account. */
export const unlinkCoinpay = async (userId: string): Promise<UnlinkResult> => {
  if ((await coinpayIdentityForUser(userId)) === null) return { ok: false, code: 'NOT_LINKED' };
  if (!(await hasPasswordLogin(userId))) return { ok: false, code: 'ONLY_SIGN_IN' };
  const db = await globalDb();
  await execute(db, 'DELETE FROM coinpay_identities WHERE user_id = ?', [userId]);
  return { ok: true };
};

// ── A real address for a CoinPay-only account ───────────────────────────────

export const EMAIL_CLAIM_TTL_SECONDS = 60 * 60 * 24;

export class EmailClaimError extends Error {
  readonly code: 'INVALID_EMAIL' | 'EMAIL_TAKEN' | 'NOT_PLACEHOLDER';
  constructor(code: 'INVALID_EMAIL' | 'EMAIL_TAKEN' | 'NOT_PLACEHOLDER', message: string) {
    super(message);
    this.name = 'EmailClaimError';
    this.code = code;
  }
}

const emailTaken = async (email: string): Promise<boolean> => {
  const db = await globalDb();
  const row = await get<{ id: string }>(db, 'SELECT id FROM users WHERE email_normalized = ?', [
    normalizeEmail(email),
  ]);
  return row !== undefined;
};

/**
 * Issues a single-use link that, once opened, makes `email` this account's
 * verified address. Only for accounts still on a CoinPay placeholder, and the
 * address is written only after the link proves the person can read its mail.
 */
export const requestEmailClaim = async (userId: string, email: string): Promise<string> => {
  const user = await findUserById(userId);
  if (user === null || !isPlaceholderEmail(user.email)) {
    throw new EmailClaimError('NOT_PLACEHOLDER', 'This account already has an email address.');
  }
  if (!isValidEmail(email) || isPlaceholderEmail(email)) {
    throw new EmailClaimError('INVALID_EMAIL', 'That does not look like an email address.');
  }
  if (await emailTaken(email)) {
    throw new EmailClaimError(
      'EMAIL_TAKEN',
      'That address belongs to another account. Sign in to it and connect CoinPay from its Account page.',
    );
  }
  const db = await globalDb();
  await execute(db, 'DELETE FROM user_tokens WHERE user_id = ? AND kind = ?', [userId, 'claim']);
  const secret = randomBytes(32).toString('base64url');
  await execute(
    db,
    `INSERT INTO user_tokens (id, user_id, kind, token_hash, expires_at, created_at, payload)
     VALUES (?, ?, 'claim', ?, ?, ?, ?)`,
    [
      newId('tok'),
      userId,
      sha256(secret),
      new Date(Date.now() + EMAIL_CLAIM_TTL_SECONDS * 1000).toISOString(),
      nowIso(),
      email.trim(),
    ],
  );
  return secret;
};

/** Single use. Returns the account whose address was set, or null. */
export const consumeEmailClaim = async (secret: string): Promise<string | null> => {
  if (secret.length === 0) return null;
  const db = await globalDb();
  const hash = sha256(secret);
  const row = await get<{ user_id: string; expires_at: string; payload: string | null }>(
    db,
    "SELECT user_id, expires_at, payload FROM user_tokens WHERE token_hash = ? AND kind = 'claim'",
    [hash],
  );
  if (row === undefined) return null;
  const deleted = await execute(db, 'DELETE FROM user_tokens WHERE token_hash = ?', [hash]);
  if (deleted.rowsAffected !== 1) return null;
  if (new Date(row.expires_at).getTime() <= Date.now() || row.payload === null) return null;

  const user = await findUserById(row.user_id);
  if (user === null || !isPlaceholderEmail(user.email)) return null;
  if (await emailTaken(row.payload)) return null;

  await execute(
    db,
    'UPDATE users SET email = ?, email_normalized = ?, email_verified_at = ?, updated_at = ? WHERE id = ?',
    [row.payload, normalizeEmail(row.payload), nowIso(), nowIso(), row.user_id],
  );
  return row.user_id;
};
