import {
  createProfileHandlers,
  createProfileStore,
  saveSignupProfile,
  validateProfile,
  type ProfileStore,
  type ValidationResult,
} from '@profullstack/profile';
import { globalDb } from '@reeleel/core';

/**
 * The house signup profile (@profullstack/profile): first and last name,
 * company domain, job title and LinkedIn, in `user_profiles` keyed by
 * users.id (migration 0003_user_profiles). Same registry database as the
 * accounts, so Postgres when hosted and the local file otherwise; the package
 * reads the dialect off the client.
 *
 * Not memoized: tests move REELEEL_HOME and reset the database cache, and the
 * store is only a thin wrapper around whichever client is current.
 */
export const profileStore = async (): Promise<ProfileStore> =>
  createProfileStore(await globalDb(), { keyType: 'text' });

/** The profile fields /register asks for beside its own email box. */
export const SIGNUP_PROFILE_FIELDS = [
  'first_name',
  'last_name',
  'company_domain',
  'job_title',
  'linkedin_url',
] as const;

/** Checked before the account is created, so a refused form makes nothing. */
export const validateSignupProfile = (input: Record<string, unknown>): ValidationResult =>
  validateProfile(input);

/**
 * Saves the signup form's profile once the account exists. A failure is
 * logged and swallowed: it must never fail a registration that already
 * succeeded, and GET/PATCH /api/v1/me/profile lets the person fill it in.
 */
export const saveRegistrationProfile = async (
  user: { id: string; email: string },
  input: Record<string, unknown>,
): Promise<void> => {
  try {
    await saveSignupProfile(await profileStore(), user.id, input, { email: user.email });
  } catch (error) {
    process.stderr.write(`signup profile not saved: ${String(error)}\n`);
  }
};

/** GET / PUT / PATCH handlers for one request's signed-in user. */
export const profileHandlers = async (
  user: { id: string; email: string } | null,
): Promise<ReturnType<typeof createProfileHandlers>> =>
  createProfileHandlers({
    store: await profileStore(),
    getUser: () => (user === null ? null : { id: user.id, email: user.email }),
  });
