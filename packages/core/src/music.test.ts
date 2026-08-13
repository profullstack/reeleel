import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  compose,
  composeOrSkip,
  isMusicMood,
  MUSIC_MOOD_NAMES,
  MUSIC_MOODS,
  musicCredentials,
  musicPrompt,
  type MusicCredentials,
} from './music.js';
import { ReelEelError } from './errors.js';

/**
 * A backing track is the one part of a highlight reel that reliably gets it
 * taken down. Every recognisable song is licensed, so the reel a parent
 * actually wants to share is the one that gets muted.
 *
 * These tests hold two lines. The first is that nothing about the child ever
 * reaches the music service — the prompt vocabulary is closed, and that is
 * asserted rather than assumed. The second is that failing to make music never
 * costs a parent the video: every failure path returns a reel without a bed.
 */

const CREDENTIALS: MusicCredentials = {
  projectId: 'proj',
  accessToken: 'ya29.test',
  location: 'us-central1',
};

const WAV = Buffer.from('RIFFfake-wave-data').toString('base64');

let dir: string;
const savedEnv: Record<string, string | undefined> = {};
const MANAGED = ['GOOGLE_CLOUD_PROJECT', 'GOOGLE_ACCESS_TOKEN', 'GOOGLE_CLOUD_LOCATION'];

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'reeleel-music-'));
  for (const key of MANAGED) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const key of MANAGED) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

/** A fetch stub that records requests and returns a canned prediction. */
const stubFetch = (
  response: { ok?: boolean; status?: number; body?: unknown; text?: string } = {},
): typeof fetch & { calls: { url: string; body: Record<string, unknown> }[] } => {
  const calls: { url: string; body: Record<string, unknown> }[] = [];

  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
    });

    return {
      ok: response.ok ?? true,
      status: response.status ?? 200,
      json: async () => response.body ?? { predictions: [{ bytesBase64Encoded: WAV }] },
      text: async () => response.text ?? '',
    } as unknown as Response;
  }) as typeof fetch & { calls: typeof calls };

  impl.calls = calls;
  return impl;
};

describe('the prompt vocabulary is closed', () => {
  it('offers a fixed set of moods', () => {
    expect(MUSIC_MOOD_NAMES.sort()).toEqual([
      'calm',
      'cinematic',
      'determined',
      'hopeful',
      'playful',
      'triumphant',
    ]);
  });

  it('accepts only those moods', () => {
    expect(isMusicMood('triumphant')).toBe(true);
    expect(isMusicMood('spooky')).toBe(false);
    expect(isMusicMood(undefined)).toBe(false);
    expect(isMusicMood(42)).toBe(false);
  });

  it('rejects a mood outside the set rather than sending it', async () => {
    const fetchImpl = stubFetch();

    await expect(
      compose('spooky' as never, dir, { credentials: CREDENTIALS, fetchImpl }),
    ).rejects.toThrow(ReelEelError);
    expect(fetchImpl.calls).toHaveLength(0);
  });

  it('describes a mood and nothing else', () => {
    // No preset may contain anything that could identify a child, a team or a
    // game. This is the check that keeps the privacy claim true as moods are
    // added later.
    for (const mood of MUSIC_MOOD_NAMES) {
      const prompt = musicPrompt(mood);
      expect(prompt).toMatch(/instrumental/i);
      expect(prompt).not.toMatch(/name|team|player|athlete|school|number|child/i);
    }
  });

  it('asks for no vocals, so words do not fight the commentary', async () => {
    const fetchImpl = stubFetch();
    await compose('hopeful', dir, { credentials: CREDENTIALS, fetchImpl });

    const instance = (fetchImpl.calls[0]?.body.instances as { negative_prompt: string }[])[0]!;
    expect(instance.negative_prompt).toContain('vocals');
    expect(instance.negative_prompt).toContain('lyrics');
  });
});

describe('generating a track', () => {
  it('writes the returned audio to disk', async () => {
    const output = await compose('triumphant', dir, {
      credentials: CREDENTIALS,
      fetchImpl: stubFetch(),
    });

    expect(existsSync(output)).toBe(true);
    expect(output.endsWith('.wav')).toBe(true);
    expect(readFileSync(output).toString()).toBe('RIFFfake-wave-data');
  });

  it('sends the prompt for the chosen mood to the right project', async () => {
    const fetchImpl = stubFetch();
    await compose('determined', dir, { credentials: CREDENTIALS, fetchImpl });

    const call = fetchImpl.calls[0]!;
    expect(call.url).toContain('us-central1-aiplatform.googleapis.com');
    expect(call.url).toContain('/projects/proj/');
    expect((call.body.instances as { prompt: string }[])[0]!.prompt).toBe(MUSIC_MOODS.determined);
  });

  it('honours a non-default location', async () => {
    const fetchImpl = stubFetch();
    await compose('calm', dir, {
      credentials: { ...CREDENTIALS, location: 'europe-west4' },
      fetchImpl,
    });

    expect(fetchImpl.calls[0]!.url).toContain('europe-west4-aiplatform');
  });

  it('caches by mood, model and seed so a re-render does not re-pay', async () => {
    const fetchImpl = stubFetch();

    const first = await compose('playful', dir, { credentials: CREDENTIALS, fetchImpl, seed: 7 });
    const second = await compose('playful', dir, { credentials: CREDENTIALS, fetchImpl, seed: 7 });

    expect(second).toBe(first);
    expect(fetchImpl.calls).toHaveLength(1);
  });

  it('treats a different seed as a different track', async () => {
    const fetchImpl = stubFetch();

    const a = await compose('playful', dir, { credentials: CREDENTIALS, fetchImpl, seed: 1 });
    const b = await compose('playful', dir, { credentials: CREDENTIALS, fetchImpl, seed: 2 });

    expect(a).not.toBe(b);
    expect(fetchImpl.calls).toHaveLength(2);
  });

  it('treats a different mood as a different track', async () => {
    const fetchImpl = stubFetch();

    const a = await compose('calm', dir, { credentials: CREDENTIALS, fetchImpl });
    const b = await compose('cinematic', dir, { credentials: CREDENTIALS, fetchImpl });

    expect(a).not.toBe(b);
  });

  it('reports the service status without leaking the token', async () => {
    const fetchImpl = stubFetch({ ok: false, status: 403, text: 'permission denied' });

    await expect(
      compose('hopeful', dir, { credentials: CREDENTIALS, fetchImpl }),
    ).rejects.toMatchObject({ code: 'MUSIC_FAILED' });

    await expect(
      compose('hopeful', dir, { credentials: CREDENTIALS, fetchImpl }),
    ).rejects.not.toThrow(/ya29/);
  });

  it('fails clearly when the response carries no audio', async () => {
    const fetchImpl = stubFetch({ body: { predictions: [] } });

    await expect(
      compose('hopeful', dir, { credentials: CREDENTIALS, fetchImpl }),
    ).rejects.toMatchObject({ code: 'MUSIC_FAILED' });
  });
});

describe('reading credentials', () => {
  it('returns null unless both the project and the token are set', () => {
    expect(musicCredentials()).toBeNull();

    process.env.GOOGLE_CLOUD_PROJECT = 'proj';
    expect(musicCredentials()).toBeNull();

    process.env.GOOGLE_ACCESS_TOKEN = 'tok';
    expect(musicCredentials()).toEqual({
      projectId: 'proj',
      accessToken: 'tok',
      location: 'us-central1',
    });
  });

  it('ignores blank values', () => {
    process.env.GOOGLE_CLOUD_PROJECT = '  ';
    process.env.GOOGLE_ACCESS_TOKEN = 'tok';

    expect(musicCredentials()).toBeNull();
  });
});

describe('never costing a parent the reel', () => {
  it('skips quietly with no mood chosen', async () => {
    expect(await composeOrSkip(undefined, dir)).toBeNull();
  });

  it('skips and explains when there are no credentials', async () => {
    const reasons: string[] = [];

    const result = await composeOrSkip('hopeful', dir, { onSkip: (r) => reasons.push(r) });

    expect(result).toBeNull();
    expect(reasons[0]).toContain('without a backing track');
  });

  it('skips rather than propagating a service failure', async () => {
    const reasons: string[] = [];

    const result = await composeOrSkip('hopeful', dir, {
      credentials: CREDENTIALS,
      fetchImpl: stubFetch({ ok: false, status: 500, text: 'upstream' }),
      onSkip: (r) => reasons.push(r),
    });

    expect(result).toBeNull();
    expect(reasons[0]).toContain('500');
  });

  it('returns the track when everything works', async () => {
    const result = await composeOrSkip('triumphant', dir, {
      credentials: CREDENTIALS,
      fetchImpl: stubFetch(),
    });

    expect(result).not.toBeNull();
    expect(existsSync(result!)).toBe(true);
  });

  it('picks up credentials from the environment', async () => {
    process.env.GOOGLE_CLOUD_PROJECT = 'env-proj';
    process.env.GOOGLE_ACCESS_TOKEN = 'env-tok';
    const fetchImpl = stubFetch();

    const result = await composeOrSkip('calm', dir, { fetchImpl });

    expect(result).not.toBeNull();
    expect(fetchImpl.calls[0]!.url).toContain('/projects/env-proj/');
  });
});
