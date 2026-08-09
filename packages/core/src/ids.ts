import { randomUUID } from 'node:crypto';

/** Short, sortable-ish, copy-pasteable id: `prj_9f2c1a4b`. */
export const newId = (prefix: string): string =>
  `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 8)}`;

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
