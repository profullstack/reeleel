import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import type { ScryptOptions } from 'node:crypto';

/**
 * Hand-rolled rather than promisify(): the promisified overload drops the
 * options argument, and the cost parameters are the entire point here.
 */
const scrypt = (
  password: string,
  salt: Buffer,
  keyLength: number,
  options: ScryptOptions,
): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    scryptCallback(password, salt, keyLength, options, (error, derived) => {
      if (error !== null) reject(error);
      else resolve(derived);
    });
  });

/**
 * Password hashing with scrypt from node:crypto — deliberately no new
 * dependency. scrypt is memory-hard and in the standard library, which beats
 * pulling argon2 (a native build) into an image that already has to stay
 * reproducible across platforms.
 *
 * Stored as `scrypt$N$r$p$salt$hash`, all base64url, so the cost parameters
 * travel with the hash and can be raised later without invalidating old ones.
 */
export interface ScryptParams {
  N: number;
  r: number;
  p: number;
  keyLength: number;
}

// 16 MiB of memory per hash (128 * N * r). Comfortably under Node's 32 MiB
// default maxmem, and slow enough to make offline cracking expensive.
export const DEFAULT_PARAMS: ScryptParams = { N: 16384, r: 8, p: 1, keyLength: 32 };

const encode = (buffer: Buffer): string => buffer.toString('base64url');

export const hashPassword = async (
  password: string,
  params: ScryptParams = DEFAULT_PARAMS,
): Promise<string> => {
  const salt = randomBytes(16);
  const derived = await scrypt(password.normalize('NFKC'), salt, params.keyLength, {
    N: params.N,
    r: params.r,
    p: params.p,
  });

  return ['scrypt', params.N, params.r, params.p, encode(salt), encode(derived)].join('$');
};

export const verifyPassword = async (password: string, stored: string): Promise<boolean> => {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const [, rawN, rawR, rawP, rawSalt, rawHash] = parts;
  const N = Number(rawN);
  const r = Number(rawR);
  const p = Number(rawP);
  if (![N, r, p].every((value) => Number.isInteger(value) && value > 0)) return false;
  if (rawSalt === undefined || rawHash === undefined) return false;

  const salt = Buffer.from(rawSalt, 'base64url');
  const expected = Buffer.from(rawHash, 'base64url');
  if (expected.length === 0) return false;

  try {
    const derived = await scrypt(password.normalize('NFKC'), salt, expected.length, {
      N,
      r,
      p,
    });
    return timingSafeEqual(derived, expected);
  } catch {
    // Bad parameters in a stored hash should read as "wrong password", not crash.
    return false;
  }
};

export interface PasswordProblem {
  ok: boolean;
  reason?: string;
}

/**
 * Length over composition rules. Arbitrary symbol requirements push people
 * toward `Password1!` and nothing else.
 */
export const MIN_PASSWORD_LENGTH = 10;

export const checkPasswordStrength = (password: string): PasswordProblem => {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, reason: `Use at least ${MIN_PASSWORD_LENGTH} characters.` };
  }
  if (password.length > 4096) {
    return { ok: false, reason: 'That password is unreasonably long.' };
  }
  return { ok: true };
};
