import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { all, execute, get, globalDb } from '@reeleel/core';

import { hashPassword, verifyPassword } from './passwords.js';

export interface User {
  id: string;
  email: string;
  displayName: string | null;
  emailVerifiedAt: string | null;
  status: 'active' | 'disabled';
  createdAt: string;
}

interface UserRow {
  id: string;
  email: string;
  email_normalized: string;
  password_hash: string;
  display_name: string | null;
  email_verified_at: string | null;
  status: 'active' | 'disabled';
  created_at: string;
  updated_at: string;
}

const toUser = (row: UserRow): User => ({
  id: row.id,
  email: row.email,
  displayName: row.display_name,
  emailVerifiedAt: row.email_verified_at,
  status: row.status,
  createdAt: row.created_at,
});

const nowIso = (): string => new Date().toISOString();
const newId = (prefix: string): string => `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 12)}`;

/** Case and whitespace are not meaningful in the local part for our purposes. */
export const normalizeEmail = (email: string): string => email.trim().toLowerCase();

/**
 * Deliberately permissive. Over-strict regexes reject valid addresses; the
 * verification email is what actually proves an address works.
 */
export const isValidEmail = (email: string): boolean => {
  const trimmed = email.trim();
  if (trimmed.length < 3 || trimmed.length > 254) return false;
  if (/\s/.test(trimmed)) return false;
  const at = trimmed.indexOf('@');
  if (at <= 0 || at !== trimmed.lastIndexOf('@')) return false;
  const domain = trimmed.slice(at + 1);
  return domain.includes('.') && !domain.startsWith('.') && !domain.endsWith('.');
};

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

export const findUserByEmail = async (email: string): Promise<User | null> => {
  const db = await globalDb();
  const row = await get<UserRow>(db, 'SELECT * FROM users WHERE email_normalized = ?', [
    normalizeEmail(email),
  ]);
  return row === undefined ? null : toUser(row);
};

export const findUserById = async (id: string): Promise<User | null> => {
  const db = await globalDb();
  const row = await get<UserRow>(db, 'SELECT * FROM users WHERE id = ?', [id]);
  return row === undefined ? null : toUser(row);
};

export const countUsers = async (): Promise<number> => {
  const db = await globalDb();
  const row = await get<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM users');
  return Number(row?.n ?? 0);
};

export class UserError extends Error {
  readonly code: 'EMAIL_TAKEN' | 'INVALID_EMAIL';
  constructor(code: 'EMAIL_TAKEN' | 'INVALID_EMAIL', message: string) {
    super(message);
    this.name = 'UserError';
    this.code = code;
  }
}

export interface CreateUserInput {
  email: string;
  password: string;
  displayName?: string;
}

export const createUser = async (input: CreateUserInput): Promise<User> => {
  if (!isValidEmail(input.email)) {
    throw new UserError('INVALID_EMAIL', 'That does not look like an email address.');
  }

  const db = await globalDb();
  const normalized = normalizeEmail(input.email);
  const existing = await get<{ id: string }>(
    db,
    'SELECT id FROM users WHERE email_normalized = ?',
    [normalized],
  );
  if (existing !== undefined) {
    throw new UserError('EMAIL_TAKEN', 'An account with that email already exists.');
  }

  const id = newId('usr');
  const timestamp = nowIso();
  await execute(
    db,
    `INSERT INTO users
       (id, email, email_normalized, password_hash, display_name, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
    [
      id,
      input.email.trim(),
      normalized,
      await hashPassword(input.password),
      input.displayName?.trim() ?? null,
      timestamp,
      timestamp,
    ],
  );

  const created = await findUserById(id);
  if (created === null) throw new Error('User vanished immediately after creation.');
  return created;
};

/**
 * Returns the user only on a correct password for an active account. Always
 * runs a hash comparison, even when the address is unknown, so response timing
 * does not reveal whether an account exists.
 */
export const verifyLogin = async (email: string, password: string): Promise<User | null> => {
  const db = await globalDb();
  const row = await get<UserRow>(db, 'SELECT * FROM users WHERE email_normalized = ?', [
    normalizeEmail(email),
  ]);

  const storedHash =
    row?.password_hash ??
    // A syntactically valid hash of a value nobody knows, purely to burn time.
    'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

  const ok = await verifyPassword(password, storedHash);
  if (!ok || row === undefined || row.status !== 'active') return null;
  return toUser(row);
};

export const markEmailVerified = async (userId: string): Promise<void> => {
  const db = await globalDb();
  await execute(db, 'UPDATE users SET email_verified_at = ?, updated_at = ? WHERE id = ?', [
    nowIso(),
    nowIso(),
    userId,
  ]);
};

export const setPassword = async (userId: string, password: string): Promise<void> => {
  const db = await globalDb();
  await execute(db, 'UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?', [
    await hashPassword(password),
    nowIso(),
    userId,
  ]);
  // Changing a password must not leave old sessions alive elsewhere.
  await revokeAllSessions(userId);
};

// ── Sessions ────────────────────────────────────────────────────────────────
// The cookie carries a high-entropy secret; only its SHA-256 lives in the
// database, so a leaked table cannot be replayed as a live session.

export const DEFAULT_SESSION_SECONDS = 60 * 60 * 24 * 14;

export const createUserSession = async (
  userId: string,
  ttlSeconds = DEFAULT_SESSION_SECONDS,
): Promise<string> => {
  const secret = randomBytes(32).toString('base64url');
  const db = await globalDb();
  await execute(
    db,
    'INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)',
    [sha256(secret), userId, new Date(Date.now() + ttlSeconds * 1000).toISOString(), nowIso()],
  );
  return secret;
};

export const userForSession = async (secret: string): Promise<User | null> => {
  if (secret.length === 0) return null;
  const db = await globalDb();
  const row = await get<{ user_id: string; expires_at: string }>(
    db,
    'SELECT user_id, expires_at FROM sessions WHERE id = ?',
    [sha256(secret)],
  );
  if (row === undefined) return null;

  if (new Date(row.expires_at).getTime() <= Date.now()) {
    await execute(db, 'DELETE FROM sessions WHERE id = ?', [sha256(secret)]);
    return null;
  }

  await execute(db, 'UPDATE sessions SET last_seen_at = ? WHERE id = ?', [nowIso(), sha256(secret)]);
  const user = await findUserById(row.user_id);
  return user !== null && user.status === 'active' ? user : null;
};

export const revokeSession = async (secret: string): Promise<void> => {
  const db = await globalDb();
  await execute(db, 'DELETE FROM sessions WHERE id = ?', [sha256(secret)]);
};

export const revokeAllSessions = async (userId: string): Promise<void> => {
  const db = await globalDb();
  await execute(db, 'DELETE FROM sessions WHERE user_id = ?', [userId]);
};

/** Housekeeping for expired rows; safe to call at any time. */
export const purgeExpired = async (): Promise<void> => {
  const db = await globalDb();
  await execute(db, 'DELETE FROM sessions WHERE expires_at <= ?', [nowIso()]);
  await execute(db, 'DELETE FROM user_tokens WHERE expires_at <= ?', [nowIso()]);
};

// ── One-shot tokens (email verification, password reset) ────────────────────

export type TokenKind = 'verify' | 'reset';

export const TOKEN_TTL: Record<TokenKind, number> = {
  verify: 60 * 60 * 24,
  // Reset links are the more dangerous of the two, so they live an hour.
  reset: 60 * 60,
};

export const issueToken = async (userId: string, kind: TokenKind): Promise<string> => {
  const db = await globalDb();
  // Only one live token per kind, so an old link stops working once a new one
  // is requested.
  await execute(db, 'DELETE FROM user_tokens WHERE user_id = ? AND kind = ?', [userId, kind]);

  const secret = randomBytes(32).toString('base64url');
  await execute(
    db,
    `INSERT INTO user_tokens (id, user_id, kind, token_hash, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      newId('tok'),
      userId,
      kind,
      sha256(secret),
      new Date(Date.now() + TOKEN_TTL[kind] * 1000).toISOString(),
      nowIso(),
    ],
  );
  return secret;
};

/** Single use: a successful consume deletes the token. */
export const consumeToken = async (secret: string, kind: TokenKind): Promise<string | null> => {
  if (secret.length === 0) return null;
  const db = await globalDb();
  const hash = sha256(secret);

  const row = await get<{ user_id: string; expires_at: string; used_at: string | null }>(
    db,
    'SELECT user_id, expires_at, used_at FROM user_tokens WHERE token_hash = ? AND kind = ?',
    [hash, kind],
  );
  if (row === undefined || row.used_at !== null) return null;

  if (new Date(row.expires_at).getTime() <= Date.now()) {
    await execute(db, 'DELETE FROM user_tokens WHERE token_hash = ?', [hash]);
    return null;
  }

  await execute(db, 'DELETE FROM user_tokens WHERE token_hash = ?', [hash]);
  return row.user_id;
};

export const listUsers = async (): Promise<User[]> => {
  const db = await globalDb();
  const rows = await all<UserRow>(db, 'SELECT * FROM users ORDER BY created_at');
  return rows.map(toUser);
};
