import { mkdirSync } from 'node:fs';
import path from 'node:path';

import {
  createFileClient,
  createGlobalClient,
  migrate,
  type Client,
} from '@reeleel/db';

import { dataHome, databasePath, globalDatabasePath } from './layout.js';

export {
  all,
  boolToInt,
  changes,
  execute,
  get,
  intToBool,
  nullableBool,
  parseJson,
  toNumber,
} from '@reeleel/db';
export type { Client, InValue, ResultSet, Row } from '@reeleel/db';
export { DbConfigError, migrationStatus, readDbEnv } from '@reeleel/db';

/**
 * Clients are cached per database because opening one runs migrations, and a
 * CLI command can touch the same project a dozen times. `resetDbCache` exists
 * for tests, which move REELEEL_HOME between cases.
 */
const projectClients = new Map<string, Client>();
let globalClient: Client | null = null;

export const projectDb = async (root: string): Promise<Client> => {
  const key = path.resolve(root);
  const cached = projectClients.get(key);
  if (cached !== undefined) return cached;

  const client = createFileClient(databasePath(key));
  // SQLite defaults foreign keys OFF, and we rely on ON DELETE CASCADE to keep
  // tracks and clips from outliving the video they belong to.
  await client.execute('PRAGMA foreign_keys = ON');
  await migrate(client, 'project');
  projectClients.set(key, client);
  return client;
};

export const globalDb = async (): Promise<Client> => {
  if (globalClient !== null) return globalClient;

  mkdirSync(dataHome(), { recursive: true });
  const client = createGlobalClient(globalDatabasePath());
  await migrate(client, 'global');
  globalClient = client;
  return client;
};

export const resetDbCache = (): void => {
  for (const client of projectClients.values()) client.close();
  projectClients.clear();
  globalClient?.close();
  globalClient = null;
};

/** Closes every open client. Call before the process exits. */
export const closeDatabases = (): void => resetDbCache();

export const withProjectDb = async <T>(
  root: string,
  fn: (client: Client) => Promise<T>,
): Promise<T> => fn(await projectDb(root));

export const withGlobalDb = async <T>(fn: (client: Client) => Promise<T>): Promise<T> =>
  fn(await globalDb());
