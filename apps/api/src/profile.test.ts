import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let home: string;

beforeAll(() => {
  home = mkdtempSync(path.join(tmpdir(), 'reeleel-profile-'));
  process.env['REELEEL_HOME'] = home;
});

afterAll(async () => {
  const { resetDbCache } = await import('@reeleel/core');
  resetDbCache();
  rmSync(home, { recursive: true, force: true });
  delete process.env['REELEEL_HOME'];
});

const TIMEOUT = 25_000;

describe('signup profile', () => {
  it(
    'stores what the register form gave once the account exists',
    async () => {
      const { createUser } = await import('./users.js');
      const { profileStore, saveRegistrationProfile, validateSignupProfile } =
        await import('./profile.js');

      const input = {
        email: 'ada@acme.com',
        first_name: 'Ada',
        last_name: 'Lovelace',
        company_domain: 'https://www.Acme.com/about',
        job_title: 'VP Engineering',
        linkedin_url: 'in/ada-lovelace',
      };
      const check = validateSignupProfile(input);
      expect(check.ok).toBe(true);

      const user = await createUser({ email: input.email, password: 'a-long-password' });
      await saveRegistrationProfile(user, check.profile);

      const saved = await (await profileStore()).get(user.id);
      expect(saved).toMatchObject({
        user_id: user.id,
        email: 'ada@acme.com',
        first_name: 'Ada',
        last_name: 'Lovelace',
        company_domain: 'acme.com',
        job_title: 'VP Engineering',
        linkedin_url: 'https://www.linkedin.com/in/ada-lovelace',
      });
    },
    TIMEOUT,
  );

  it('refuses a signup without a name before any account is made', async () => {
    const { validateSignupProfile } = await import('./profile.js');
    const check = validateSignupProfile({ email: 'ada@acme.com', first_name: 'Ada' });
    expect(check.ok).toBe(false);
    expect(check.errors.last_name).toBeTruthy();
  });

  it(
    'answers /api/v1/me/profile with 401 for nobody signed in',
    async () => {
      const { profileHandlers } = await import('./profile.js');
      const res = await (
        await profileHandlers(null)
      ).GET(new Request('http://x/api/v1/me/profile'));
      expect(res.status).toBe(401);
    },
    TIMEOUT,
  );
});
