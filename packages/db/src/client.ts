import { createClient } from '@libsql/client';
import type { Client, InValue, ResultSet, Row } from '@libsql/client';
import { createClient as createPostgresClient } from '@profullstack/libsql-pg';

/**
 * ReelEel is local-first, so a project database is a plain local libSQL file:
 * no network, no account, works on a plane, and the project folder stays
 * portable. That does not change.
 *
 * The machine-wide registry (projects, models, and the accounts of a hosted
 * deployment) is the one database that can live on a server. It used to point
 * at Turso through an embedded replica; it now points at Postgres through
 * @profullstack/libsql-pg, which keeps the @libsql/client surface every helper
 * below uses and rewrites the remaining SQLite idioms per statement. With no
 * DATABASE_URL the registry is a local file, as before.
 */
export interface DbEnv {
  /** Postgres URL for the machine registry (`postgres://…`). */
  databaseUrl?: string | undefined;
  /** The retired Turso setting, read only so it can be refused with a clear message. */
  legacyUrl?: string | undefined;
}

export const readDbEnv = (env: NodeJS.ProcessEnv = process.env): DbEnv => ({
  databaseUrl: env['DATABASE_URL'],
  legacyUrl: env['REELEEL_DB_URL'],
});

const POSTGRES_URL = /^postgres(ql)?:\/\//i;

export class DbConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DbConfigError';
  }
}

/** A local libSQL file. This is what every project database uses. */
export const createFileClient = (filePath: string): Client =>
  createClient({ url: `file:${filePath.replace(/^file:/, '')}` });

/** True when a client talks to Postgres (the registry) rather than a local file. */
export const isPostgresClient = (client: Client): boolean => client.protocol === 'postgres';

/**
 * The registry's Postgres URL, or undefined when the registry is a local file.
 *
 * Fails fast rather than falling back: a DATABASE_URL that is not postgres://
 * or a leftover REELEEL_DB_URL is a misconfigured deployment, and writing the
 * registry to a file on a server disk would look like it worked.
 */
export const postgresUrl = (env: DbEnv = readDbEnv()): string | undefined => {
  if (env.legacyUrl !== undefined && env.legacyUrl.length > 0) {
    throw new DbConfigError(
      'REELEEL_DB_URL is no longer read: the machine registry moved from Turso to Postgres. ' +
        'Copy the data with `npx libsql-pg copy --from "$REELEEL_DB_URL" --token "$REELEEL_DB_AUTH_TOKEN" --to "$DATABASE_URL" --verify`, ' +
        'set DATABASE_URL to the postgres:// URL and unset REELEEL_DB_URL.',
    );
  }
  const url = env.databaseUrl;
  if (url === undefined || url.length === 0) return undefined;
  if (!POSTGRES_URL.test(url)) {
    throw new DbConfigError(
      `DATABASE_URL must be a postgres:// or postgresql:// URL, got "${url.split(':')[0]}:". ` +
        'The registry runs on Postgres or, with DATABASE_URL unset, a local file; libsql:// and file: URLs are not accepted here.',
    );
  }
  return url;
};

/**
 * The machine-wide database: Postgres when DATABASE_URL is set, otherwise a
 * local file.
 *
 * The Postgres client is typed as the libSQL `Client` on purpose: it has the
 * same execute / executeMultiple / close surface, and every helper and call
 * site was written against that type.
 */
export const createGlobalClient = (localFallbackPath: string, env: DbEnv = readDbEnv()): Client => {
  const url = postgresUrl(env);
  if (url === undefined) return createFileClient(localFallbackPath);
  return createPostgresClient({ url }) as unknown as Client;
};

/**
 * Fail-closed guard for server entry points. A hosted deployment (listening on
 * a non-loopback interface) must keep its registry in Postgres: a file on the
 * container disk vanishes with the container, and accounts live in it.
 * Loopback (someone's own machine) may still use the local file.
 */
export const assertDatabaseConfigured = (host: string, env: DbEnv = readDbEnv()): void => {
  const url = postgresUrl(env);
  if (url !== undefined) return;
  if (/^(127\.0\.0\.1|::1|localhost)$/.test(host)) return;
  throw new DbConfigError(
    `Refusing to listen on ${host} without DATABASE_URL.\n` +
      'A hosted ReelEel keeps its registry and accounts in Postgres; set DATABASE_URL=postgres://...\n' +
      'Or bind to loopback (HOST=127.0.0.1) to run it only on this machine with a local registry file.',
  );
};

export type { Client, ResultSet, Row, InValue };

/** Convenience wrappers so call sites read like the old synchronous helpers. */
export const all = async <T>(
  client: Client,
  sql: string,
  args: InValue[] = [],
): Promise<T[]> => {
  const result = await client.execute({ sql, args });
  return result.rows as unknown as T[];
};

export const get = async <T>(
  client: Client,
  sql: string,
  args: InValue[] = [],
): Promise<T | undefined> => {
  const rows = await all<T>(client, sql, args);
  return rows[0];
};

export const execute = async (
  client: Client,
  sql: string,
  args: InValue[] = [],
): Promise<ResultSet> => client.execute({ sql, args });

/** Rows changed by the last statement, as a plain number. */
export const changes = (result: ResultSet): number => Number(result.rowsAffected);

export const boolToInt = (value: boolean): number => (value ? 1 : 0);
export const intToBool = (value: unknown): boolean => value === 1 || value === 1n || value === true;
export const nullableBool = (value: unknown): boolean | null =>
  value === null || value === undefined ? null : intToBool(value);

/** libSQL returns INTEGER columns as bigint when they exceed 2^53. */
export const toNumber = (value: unknown): number => {
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'number') return value;
  return Number(value ?? 0);
};

export const parseJson = <T>(value: unknown, fallback: T): T => {
  if (typeof value !== 'string' || value.length === 0) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
};
