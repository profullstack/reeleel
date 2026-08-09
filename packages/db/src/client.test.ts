import { describe, expect, it } from 'vitest';

import { DbConfigError, createGlobalClient, defaultReplicaPath, readDbEnv } from './client.js';

describe('readDbEnv', () => {
  it('is empty when nothing is configured — the local-first default', () => {
    const env = readDbEnv({});
    expect(env.url).toBeUndefined();
    expect(env.authToken).toBeUndefined();
  });

  it('reads Turso settings when present', () => {
    const env = readDbEnv({
      REELEEL_DB_URL: 'libsql://x.turso.io',
      REELEEL_DB_AUTH_TOKEN: 'tok',
      REELEEL_DB_SYNC_INTERVAL: '30',
    });
    expect(env.url).toBe('libsql://x.turso.io');
    expect(env.syncIntervalSeconds).toBe(30);
  });
});

describe('defaultReplicaPath', () => {
  it('never collides with the local-only database file', () => {
    // Reusing the same file makes libSQL fail with
    // Sync(InvalidLocalState("db file exists but metadata file does not")).
    const local = '/data/reeleel.db';
    expect(defaultReplicaPath(local)).not.toBe(local);
    expect(defaultReplicaPath(local)).toBe('/data/reeleel-replica.db');
  });

  it('handles a path without a .db suffix', () => {
    expect(defaultReplicaPath('/data/registry')).toBe('/data/registry-replica.db');
  });

  it('strips a file: prefix', () => {
    expect(defaultReplicaPath('file:/data/reeleel.db')).toBe('/data/reeleel-replica.db');
  });
});

describe('createGlobalClient', () => {
  it('uses a plain local file when no URL is set', () => {
    const client = createGlobalClient('/tmp/reeleel-test-global.db', {});
    expect(client).toBeDefined();
    client.close();
  });

  it('refuses a remote URL without an auth token', () => {
    expect(() =>
      createGlobalClient('/tmp/reeleel-test-global.db', { url: 'libsql://x.turso.io' }),
    ).toThrow(DbConfigError);
  });

  it('treats a bare path or file: URL as local, not remote', () => {
    for (const url of ['/tmp/reeleel-local-a.db', 'file:/tmp/reeleel-local-b.db']) {
      const client = createGlobalClient('/tmp/unused.db', { url });
      expect(client).toBeDefined();
      client.close();
    }
  });
});
