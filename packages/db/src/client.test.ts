import { describe, expect, it } from 'vitest';

import {
  DbConfigError,
  assertDatabaseConfigured,
  createGlobalClient,
  isPostgresClient,
  postgresUrl,
  readDbEnv,
} from './client.js';

describe('readDbEnv', () => {
  it('is empty when nothing is configured — the local-first default', () => {
    const env = readDbEnv({});
    expect(env.databaseUrl).toBeUndefined();
    expect(env.legacyUrl).toBeUndefined();
  });

  it('reads DATABASE_URL and the retired REELEEL_DB_URL', () => {
    const env = readDbEnv({ DATABASE_URL: 'postgres://u:p@h/d', REELEEL_DB_URL: 'libsql://x.turso.io' });
    expect(env.databaseUrl).toBe('postgres://u:p@h/d');
    expect(env.legacyUrl).toBe('libsql://x.turso.io');
  });
});

describe('postgresUrl', () => {
  it('is undefined with nothing set (local registry file)', () => {
    expect(postgresUrl({})).toBeUndefined();
    expect(postgresUrl({ databaseUrl: '' })).toBeUndefined();
  });

  it('accepts postgres:// and postgresql://', () => {
    expect(postgresUrl({ databaseUrl: 'postgres://u:p@h:5432/d' })).toBe('postgres://u:p@h:5432/d');
    expect(postgresUrl({ databaseUrl: 'postgresql://u:p@h/d' })).toBe('postgresql://u:p@h/d');
  });

  it('refuses a non-Postgres DATABASE_URL rather than falling back to a file', () => {
    expect(() => postgresUrl({ databaseUrl: 'libsql://x.turso.io' })).toThrow(DbConfigError);
    expect(() => postgresUrl({ databaseUrl: 'file:/data/reeleel.db' })).toThrow(/got "file:"/);
  });

  it('refuses the retired Turso setting with the copy recipe', () => {
    expect(() => postgresUrl({ legacyUrl: 'libsql://x.turso.io' })).toThrow(/REELEEL_DB_URL is no longer read/);
    expect(() => postgresUrl({ legacyUrl: 'libsql://x.turso.io' })).toThrow(/libsql-pg copy/);
  });
});

describe('createGlobalClient', () => {
  it('uses a plain local file when no URL is set', () => {
    const client = createGlobalClient('/tmp/reeleel-test-global.db', {});
    expect(client).toBeDefined();
    expect(isPostgresClient(client)).toBe(false);
    client.close();
  });

  it('builds a Postgres client from DATABASE_URL without connecting', () => {
    // pg pools connect lazily, so this needs no database.
    const client = createGlobalClient('/tmp/unused.db', { databaseUrl: 'postgres://u:p@127.0.0.1:1/d' });
    expect(isPostgresClient(client)).toBe(true);
    client.close();
  });

  it('refuses a remote libsql URL instead of opening an embedded replica', () => {
    expect(() =>
      createGlobalClient('/tmp/reeleel-test-global.db', { legacyUrl: 'libsql://x.turso.io' }),
    ).toThrow(DbConfigError);
  });
});

describe('assertDatabaseConfigured', () => {
  it('lets loopback run on the local file', () => {
    expect(() => assertDatabaseConfigured('127.0.0.1', {})).not.toThrow();
    expect(() => assertDatabaseConfigured('localhost', {})).not.toThrow();
  });

  it('requires Postgres on a public interface', () => {
    expect(() => assertDatabaseConfigured('0.0.0.0', {})).toThrow(/without DATABASE_URL/);
    expect(() => assertDatabaseConfigured('0.0.0.0', { databaseUrl: 'postgres://u:p@h/d' })).not.toThrow();
  });
});
