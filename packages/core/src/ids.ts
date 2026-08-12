import { randomBytes } from 'node:crypto';

/**
 * Copy-pasteable id: `prj_9f2c1a4b7e3d5061`.
 *
 * Sixty-four bits, because thirty-two was not enough for the one table that
 * actually fills up. Ids used to be the first eight hex characters of a UUID —
 * 4.3 billion values — which is ample for projects, videos and reels, and far
 * too few for tracks. A single production video already carried 8,394 of them,
 * and vetting a shirt before a track may claim whoever is standing there (#50)
 * trades spliced identities for fragments, so it multiplies that count rather
 * than reducing it. A project built from a dozen clips holds the sum, because
 * detection only clears the tracks of the video it is re-analysing.
 *
 * The birthday bound over 32 bits: 8k tracks fail one run in 125, 50k fail one
 * in four, 100k fail more often than they succeed — reported from the field as
 * "SQLITE_CONSTRAINT: UNIQUE constraint failed: tracks.id" partway through
 * building from clips, which is precisely the case that accumulates the most.
 * At 64 bits the same 100k rows collide with probability 3e-10.
 *
 * Widening rather than retrying is deliberate: a retry loop would hide a
 * collision rate instead of removing it, and the ids already written stay
 * valid — eight characters and sixteen cannot collide with each other.
 */
export const newId = (prefix: string): string => `${prefix}_${randomBytes(8).toString('hex')}`;

/** Filesystem-safe slug used for default project directory names. */
export const slugify = (value: string): string => {
  const slug = value
    .normalize('NFKD')
    // Strip combining marks so "José" slugs to "jose", not "jos-e".
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return slug.length > 0 ? slug : 'project';
};

export const nowIso = (): string => new Date().toISOString();
