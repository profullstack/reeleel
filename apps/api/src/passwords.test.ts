import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PARAMS,
  MIN_PASSWORD_LENGTH,
  checkPasswordStrength,
  hashPassword,
  verifyPassword,
} from './passwords.js';

// scrypt is intentionally slow; give these room.
const TIMEOUT = 20_000;

describe('hashPassword', () => {
  it(
    'round-trips a password',
    async () => {
      const stored = await hashPassword('correct horse battery staple');
      expect(await verifyPassword('correct horse battery staple', stored)).toBe(true);
    },
    TIMEOUT,
  );

  it(
    'rejects the wrong password',
    async () => {
      const stored = await hashPassword('correct horse battery staple');
      expect(await verifyPassword('Correct horse battery staple', stored)).toBe(false);
      expect(await verifyPassword('', stored)).toBe(false);
    },
    TIMEOUT,
  );

  it(
    'salts, so identical passwords hash differently',
    async () => {
      const a = await hashPassword('same-password-here');
      const b = await hashPassword('same-password-here');
      expect(a).not.toBe(b);
      expect(await verifyPassword('same-password-here', a)).toBe(true);
      expect(await verifyPassword('same-password-here', b)).toBe(true);
    },
    TIMEOUT,
  );

  it(
    'never stores the password itself',
    async () => {
      const stored = await hashPassword('literal-secret-value');
      expect(stored).not.toContain('literal-secret-value');
    },
    TIMEOUT,
  );

  it(
    'records its cost parameters so they can be raised later',
    async () => {
      const stored = await hashPassword('another-password');
      const [scheme, N, r, p] = stored.split('$');
      expect(scheme).toBe('scrypt');
      expect(Number(N)).toBe(DEFAULT_PARAMS.N);
      expect(Number(r)).toBe(DEFAULT_PARAMS.r);
      expect(Number(p)).toBe(DEFAULT_PARAMS.p);
    },
    TIMEOUT,
  );

  it(
    'still verifies a hash written with different parameters',
    async () => {
      const stored = await hashPassword('legacy-password', { N: 1024, r: 8, p: 1, keyLength: 32 });
      expect(await verifyPassword('legacy-password', stored)).toBe(true);
    },
    TIMEOUT,
  );
});

describe('verifyPassword', () => {
  it('treats malformed stored hashes as a failed login, not a crash', async () => {
    for (const stored of ['', 'garbage', 'scrypt$x$8$1$aaa$bbb', 'bcrypt$1$2$3$4$5', 'a$b$c$d$e$f']) {
      expect(await verifyPassword('whatever', stored)).toBe(false);
    }
  });

  it(
    'fails when the stored hash is truncated',
    async () => {
      const stored = await hashPassword('some-password-value');
      const parts = stored.split('$');
      parts[5] = '';
      expect(await verifyPassword('some-password-value', parts.join('$'))).toBe(false);
    },
    TIMEOUT,
  );
});

describe('checkPasswordStrength', () => {
  it('requires a reasonable length', () => {
    expect(checkPasswordStrength('short').ok).toBe(false);
    expect(checkPasswordStrength('a'.repeat(MIN_PASSWORD_LENGTH)).ok).toBe(true);
  });

  it('does not demand punctuation theatre', () => {
    // A long passphrase with no symbols is fine; that is the point.
    expect(checkPasswordStrength('correct horse battery staple').ok).toBe(true);
  });

  it('rejects absurd lengths', () => {
    expect(checkPasswordStrength('a'.repeat(5000)).ok).toBe(false);
  });
});
