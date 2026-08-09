import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let home: string;
let seq = 0;

const uniqueEmail = (): string => {
  seq += 1;
  return `user${seq}@example.com`;
};

beforeAll(() => {
  home = mkdtempSync(path.join(tmpdir(), 'reeleel-users-'));
  process.env['REELEEL_HOME'] = home;
});

afterAll(async () => {
  const { resetDbCache } = await import('@reeleel/core');
  resetDbCache();
  rmSync(home, { recursive: true, force: true });
  delete process.env['REELEEL_HOME'];
});

const users = async () => import('./users.js');

const TIMEOUT = 25_000;

describe('accounts', () => {
  it(
    'creates an account and finds it case-insensitively',
    async () => {
      const { createUser, findUserByEmail } = await users();
      const created = await createUser({ email: 'Casey@Example.com', password: 'a-long-password' });

      expect(created.emailVerifiedAt).toBeNull();
      expect((await findUserByEmail('casey@example.com'))?.id).toBe(created.id);
      expect((await findUserByEmail('  CASEY@EXAMPLE.COM  '))?.id).toBe(created.id);
    },
    TIMEOUT,
  );

  it(
    'refuses a duplicate address regardless of case',
    async () => {
      const { UserError, createUser } = await users();
      const email = uniqueEmail();
      await createUser({ email, password: 'a-long-password' });

      await expect(
        createUser({ email: email.toUpperCase(), password: 'another-long-password' }),
      ).rejects.toThrow(UserError);
    },
    TIMEOUT,
  );

  it('rejects an address that is not an address', async () => {
    const { createUser } = await users();
    for (const email of ['nope', 'a@', '@b.com', 'a b@c.com', 'a@b']) {
      await expect(createUser({ email, password: 'a-long-password' })).rejects.toThrow();
    }
  });

  it(
    'verifies a login only with the right password',
    async () => {
      const { createUser, verifyLogin } = await users();
      const email = uniqueEmail();
      await createUser({ email, password: 'the-real-password' });

      expect(await verifyLogin(email, 'the-real-password')).not.toBeNull();
      expect(await verifyLogin(email, 'the-wrong-password')).toBeNull();
    },
    TIMEOUT,
  );

  it(
    'returns null for an unknown address without throwing',
    async () => {
      // Also exercises the dummy-hash path that keeps timing uniform.
      const { verifyLogin } = await users();
      expect(await verifyLogin('nobody@example.com', 'whatever-password')).toBeNull();
    },
    TIMEOUT,
  );

  it(
    'marks an email verified',
    async () => {
      const { createUser, findUserById, markEmailVerified } = await users();
      const created = await createUser({ email: uniqueEmail(), password: 'a-long-password' });

      await markEmailVerified(created.id);
      expect((await findUserById(created.id))?.emailVerifiedAt).not.toBeNull();
    },
    TIMEOUT,
  );
});

describe('sessions', () => {
  it(
    'resolves a live session and forgets a revoked one',
    async () => {
      const { createUser, createUserSession, revokeSession, userForSession } = await users();
      const created = await createUser({ email: uniqueEmail(), password: 'a-long-password' });

      const secret = await createUserSession(created.id);
      expect((await userForSession(secret))?.id).toBe(created.id);

      await revokeSession(secret);
      expect(await userForSession(secret)).toBeNull();
    },
    TIMEOUT,
  );

  it('rejects an unknown or empty session secret', async () => {
    const { userForSession } = await users();
    expect(await userForSession('not-a-real-session')).toBeNull();
    expect(await userForSession('')).toBeNull();
  });

  it(
    'expires a session whose time has passed',
    async () => {
      const { createUser, createUserSession, userForSession } = await users();
      const created = await createUser({ email: uniqueEmail(), password: 'a-long-password' });

      const secret = await createUserSession(created.id, -1);
      expect(await userForSession(secret)).toBeNull();
    },
    TIMEOUT,
  );

  it(
    'changing the password signs out every other session',
    async () => {
      const { createUser, createUserSession, setPassword, userForSession, verifyLogin } =
        await users();
      const email = uniqueEmail();
      const created = await createUser({ email, password: 'original-password' });

      const laptop = await createUserSession(created.id);
      const phone = await createUserSession(created.id);
      expect(await userForSession(laptop)).not.toBeNull();

      await setPassword(created.id, 'replacement-password');

      expect(await userForSession(laptop)).toBeNull();
      expect(await userForSession(phone)).toBeNull();
      expect(await verifyLogin(email, 'replacement-password')).not.toBeNull();
      expect(await verifyLogin(email, 'original-password')).toBeNull();
    },
    TIMEOUT,
  );
});

describe('one-shot tokens', () => {
  it(
    'consumes a verification token exactly once',
    async () => {
      const { consumeToken, createUser, issueToken } = await users();
      const created = await createUser({ email: uniqueEmail(), password: 'a-long-password' });

      const token = await issueToken(created.id, 'verify');
      expect(await consumeToken(token, 'verify')).toBe(created.id);
      // Replaying a used link must fail.
      expect(await consumeToken(token, 'verify')).toBeNull();
    },
    TIMEOUT,
  );

  it(
    'will not accept a token of the wrong kind',
    async () => {
      const { consumeToken, createUser, issueToken } = await users();
      const created = await createUser({ email: uniqueEmail(), password: 'a-long-password' });

      const token = await issueToken(created.id, 'verify');
      expect(await consumeToken(token, 'reset')).toBeNull();
    },
    TIMEOUT,
  );

  it(
    'invalidates an older token when a new one is issued',
    async () => {
      const { consumeToken, createUser, issueToken } = await users();
      const created = await createUser({ email: uniqueEmail(), password: 'a-long-password' });

      const first = await issueToken(created.id, 'reset');
      const second = await issueToken(created.id, 'reset');

      expect(await consumeToken(first, 'reset')).toBeNull();
      expect(await consumeToken(second, 'reset')).toBe(created.id);
    },
    TIMEOUT,
  );

  it('rejects a garbage token', async () => {
    const { consumeToken } = await users();
    expect(await consumeToken('nonsense', 'verify')).toBeNull();
    expect(await consumeToken('', 'reset')).toBeNull();
  });
});
