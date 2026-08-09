import { createClient } from '@libsql/client';
import type { Client, InValue, ResultSet, Row } from '@libsql/client';

/**
 * ReelEel is local-first, so the default for both project data and the machine
 * registry is a plain local libSQL file — no network, no account, works on a
 * plane. Turso enters only when the user opts in by setting REELEEL_DB_URL, and
 * even then a project database stays local: syncing a family's game footage
 * metadata to the cloud has to be a deliberate choice, not a default.
 */
export interface DbEnv {
  /** Remote Turso URL (`libsql://…`). Local `file:` URLs are accepted too. */
  url?: string | undefined;
  authToken?: string | undefined;
  /** Local file backing an embedded replica when `url` is remote. */
  replicaPath?: string | undefined;
  syncIntervalSeconds?: number | undefined;
}

export const readDbEnv = (env: NodeJS.ProcessEnv = process.env): DbEnv => ({
  url: env['REELEEL_DB_URL'],
  authToken: env['REELEEL_DB_AUTH_TOKEN'],
  replicaPath: env['REELEEL_DB_REPLICA_PATH'],
  syncIntervalSeconds:
    env['REELEEL_DB_SYNC_INTERVAL'] === undefined
      ? undefined
      : Number(env['REELEEL_DB_SYNC_INTERVAL']),
});

const isRemote = (url: string): boolean =>
  url.startsWith('libsql://') || url.startsWith('https://') || url.startsWith('wss://');

export class DbConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DbConfigError';
  }
}

/** A local libSQL file. This is what every project database uses. */
export const createFileClient = (filePath: string): Client =>
  createClient({ url: `file:${filePath.replace(/^file:/, '')}` });

/**
 * The machine-wide database. Local file unless REELEEL_DB_URL points at Turso,
 * in which case we use an embedded replica so reads stay local and offline-safe
 * and writes push through when there is a connection.
 */
export const createGlobalClient = (localFallbackPath: string, env: DbEnv = readDbEnv()): Client => {
  const url = env.url;
  if (url === undefined || url.length === 0) return createFileClient(localFallbackPath);

  if (!isRemote(url)) {
    return createClient({ url: url.startsWith('file:') ? url : `file:${url}` });
  }

  if (env.authToken === undefined || env.authToken.length === 0) {
    throw new DbConfigError(
      'REELEEL_DB_URL points at a remote database but REELEEL_DB_AUTH_TOKEN is not set.',
    );
  }

  const replica = env.replicaPath ?? localFallbackPath;
  return createClient({
    url: `file:${replica.replace(/^file:/, '')}`,
    syncUrl: url,
    authToken: env.authToken,
    ...(env.syncIntervalSeconds === undefined || !Number.isFinite(env.syncIntervalSeconds)
      ? {}
      : { syncInterval: env.syncIntervalSeconds }),
  });
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
