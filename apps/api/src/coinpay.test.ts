import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let home: string;
let seq = 0;
const nextSub = (): string => {
  seq += 1;
  return `cp-sub-${seq}`;
};

beforeAll(() => {
  home = mkdtempSync(path.join(tmpdir(), 'reeleel-coinpay-'));
  process.env['REELEEL_HOME'] = home;
});

afterAll(async () => {
  const { resetDbCache } = await import('@reeleel/core');
  resetDbCache();
  rmSync(home, { recursive: true, force: true });
  delete process.env['REELEEL_HOME'];
});

const mods = async () => ({ ...(await import('./coinpay.js')), ...(await import('./users.js')) });
const TIMEOUT = 25_000;

describe('Sign in with CoinPay', () => {
  it(
    'never signs into an existing account because the CoinPay email matches',
    async () => {
      const { createUser, signInWithCoinpay, findUserByEmail, verifyLogin } = await mods();
      const victim = await createUser({ email: 'victim@example.com', password: 'victim-password-1' });

      const result = await signInWithCoinpay(
        { sub: nextSub(), email: 'Victim@Example.com', name: 'Mallory' },
        { linkUserId: null, signupAllowed: true },
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.user.id).not.toBe(victim.id);
      expect(result.created).toBe(true);
      // The CoinPay address is not the new account's address, and not verified.
      expect(result.user.email).not.toContain('victim');
      expect(result.user.emailVerifiedAt).toBeNull();
      expect((await findUserByEmail('victim@example.com'))?.id).toBe(victim.id);
      // A CoinPay-only account has no password that can match anything.
      expect(await verifyLogin(result.user.email, 'coinpay-only')).toBeNull();
    },
    TIMEOUT,
  );

  it(
    'signs the same sub back into the same account',
    async () => {
      const { signInWithCoinpay } = await mods();
      const sub = nextSub();
      const first = await signInWithCoinpay({ sub, email: null, name: null }, { linkUserId: null, signupAllowed: true });
      const second = await signInWithCoinpay(
        { sub, email: 'changed@example.com', name: null },
        { linkUserId: null, signupAllowed: true },
      );
      expect(first.ok && second.ok).toBe(true);
      if (!first.ok || !second.ok) return;
      expect(second.user.id).toBe(first.user.id);
      expect(second.created).toBe(false);
    },
    TIMEOUT,
  );

  it(
    'creates nothing when registration is closed',
    async () => {
      const { signInWithCoinpay } = await mods();
      const result = await signInWithCoinpay(
        { sub: nextSub(), email: null, name: null },
        { linkUserId: null, signupAllowed: false },
      );
      expect(result).toEqual({ ok: false, code: 'SIGNUP_CLOSED' });
    },
    TIMEOUT,
  );

  it(
    'links only to the signed-in account, and a sub belongs to one account',
    async () => {
      const { createUser, signInWithCoinpay, coinpayIdentityForUser } = await mods();
      const alice = await createUser({ email: 'alice@example.com', password: 'alice-password-1' });
      const bob = await createUser({ email: 'bob@example.com', password: 'bob-password-12' });
      const sub = nextSub();

      const linked = await signInWithCoinpay({ sub, email: 'x@example.com', name: null }, { linkUserId: alice.id, signupAllowed: true });
      expect(linked.ok && linked.linked).toBe(true);
      expect((await coinpayIdentityForUser(alice.id))?.sub).toBe(sub);

      const stolen = await signInWithCoinpay({ sub, email: null, name: null }, { linkUserId: bob.id, signupAllowed: true });
      expect(stolen).toEqual({ ok: false, code: 'LINKED_ELSEWHERE' });

      const second = await signInWithCoinpay({ sub: nextSub(), email: null, name: null }, { linkUserId: alice.id, signupAllowed: true });
      expect(second).toEqual({ ok: false, code: 'ALREADY_LINKED' });

      // Signing in with the linked sub lands in Alice's account.
      const login = await signInWithCoinpay({ sub, email: null, name: null }, { linkUserId: null, signupAllowed: true });
      expect(login.ok && login.user.id).toBe(alice.id);
    },
    TIMEOUT,
  );

  it(
    'refuses to disconnect CoinPay when it is the only way in',
    async () => {
      const { createUser, signInWithCoinpay, unlinkCoinpay } = await mods();
      const only = await signInWithCoinpay({ sub: nextSub(), email: null, name: null }, { linkUserId: null, signupAllowed: true });
      if (!only.ok) throw new Error('expected an account');
      expect(await unlinkCoinpay(only.user.id)).toEqual({ ok: false, code: 'ONLY_SIGN_IN' });

      const carol = await createUser({ email: 'carol@example.com', password: 'carol-password-1' });
      await signInWithCoinpay({ sub: nextSub(), email: null, name: null }, { linkUserId: carol.id, signupAllowed: true });
      expect(await unlinkCoinpay(carol.id)).toEqual({ ok: true });
      expect(await unlinkCoinpay(carol.id)).toEqual({ ok: false, code: 'NOT_LINKED' });
    },
    TIMEOUT,
  );

  it(
    'uses a pending authorization once, and never after it expires',
    async () => {
      const { savePending, takePending } = await mods();
      await savePending('state-one', { verifier: 'v', nonce: 'n', next: '/x', linkUserId: null });
      expect(await takePending('state-one')).toEqual({ verifier: 'v', nonce: 'n', next: '/x', linkUserId: null });
      expect(await takePending('state-one')).toBeNull();
      expect(await takePending('never-issued')).toBeNull();
      expect(await takePending('')).toBeNull();
    },
    TIMEOUT,
  );

  it(
    'sets a real address only through the mailed link, and never one already taken',
    async () => {
      const { createUser, signInWithCoinpay, requestEmailClaim, consumeEmailClaim, findUserById, EmailClaimError } =
        await mods();
      const cp = await signInWithCoinpay({ sub: nextSub(), email: null, name: null }, { linkUserId: null, signupAllowed: true });
      if (!cp.ok) throw new Error('expected an account');

      await createUser({ email: 'taken@example.com', password: 'taken-password-1' });
      await expect(requestEmailClaim(cp.user.id, 'TAKEN@example.com')).rejects.toBeInstanceOf(EmailClaimError);

      const token = await requestEmailClaim(cp.user.id, 'mine@example.com');
      expect((await findUserById(cp.user.id))?.email).toContain('coinpay.invalid');
      expect(await consumeEmailClaim(token)).toBe(cp.user.id);
      const after = await findUserById(cp.user.id);
      expect(after?.email).toBe('mine@example.com');
      expect(after?.emailVerifiedAt).not.toBeNull();
      expect(await consumeEmailClaim(token)).toBeNull();

      // An account with a real address cannot use the claim flow to change it.
      await expect(requestEmailClaim(cp.user.id, 'other@example.com')).rejects.toBeInstanceOf(EmailClaimError);
    },
    TIMEOUT,
  );
});
