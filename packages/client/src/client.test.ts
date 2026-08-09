import { describe, expect, it, vi } from 'vitest';

import { ApiError, createClient } from './index.js';

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const clientWith = (impl: typeof fetch) =>
  createClient({ baseUrl: 'https://reeleel.test/', fetchImpl: impl, token: 'tok' });

describe('request shape', () => {
  it('strips a trailing slash from the base url', async () => {
    const fetchImpl = vi.fn(async () => json({ ok: true, projects: [] }));
    await clientWith(fetchImpl as unknown as typeof fetch).projects();

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(vi.mocked(fetchImpl).mock.calls[0]?.[0]).toBe('https://reeleel.test/api/projects');
  });

  it('sends the token as a bearer header', async () => {
    const fetchImpl = vi.fn(async () => json({ ok: true, projects: [] }));
    await clientWith(fetchImpl as unknown as typeof fetch).projects();

    const init = vi.mocked(fetchImpl).mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer tok');
  });

  it('omits the auth header when there is no token', async () => {
    const fetchImpl = vi.fn(async () => json({ ok: true, user: null }));
    const client = createClient({
      baseUrl: 'https://reeleel.test',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await client.me();

    const init = vi.mocked(fetchImpl).mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>)['authorization']).toBeUndefined();
  });

  it('encodes a project reference that contains a path', async () => {
    const fetchImpl = vi.fn(async () => json({ ok: true, project: {} }));
    await clientWith(fetchImpl as unknown as typeof fetch).project('/data/projects/my game');

    expect(vi.mocked(fetchImpl).mock.calls[0]?.[0]).toContain(
      encodeURIComponent('/data/projects/my game'),
    );
  });

  it('serialises a body and sets the content type', async () => {
    const fetchImpl = vi.fn(async () => json({ ok: true, project: { id: 'prj_1' } }));
    await clientWith(fetchImpl as unknown as typeof fetch).createProject({ name: 'Cup Final' });

    const init = vi.mocked(fetchImpl).mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/json');
    expect(JSON.parse(init.body as string)).toEqual({ name: 'Cup Final' });
  });
});

describe('error handling', () => {
  it('turns the API envelope into an ApiError with its code', async () => {
    const fetchImpl = vi.fn(async () =>
      json({ ok: false, code: 'PROJECT_NOT_FOUND', error: 'No project matched.', hint: 'Try list.' }, 404),
    );

    await expect(clientWith(fetchImpl as unknown as typeof fetch).project('nope')).rejects.toMatchObject({
      code: 'PROJECT_NOT_FOUND',
      status: 404,
      hint: 'Try list.',
    });
  });

  it('flags auth failures so the app knows to sign in again', async () => {
    const fetchImpl = vi.fn(async () => json({ ok: false, code: 'UNAUTHORIZED', error: 'nope' }, 401));

    try {
      await clientWith(fetchImpl as unknown as typeof fetch).projects();
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).isAuthError).toBe(true);
    }
  });

  it('reports a network failure rather than leaking the underlying error', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('Network request failed');
    });

    await expect(clientWith(fetchImpl as unknown as typeof fetch).projects()).rejects.toMatchObject({
      code: 'NETWORK',
    });
  });

  it('treats a non-JSON body as a failure, not a crash', async () => {
    const fetchImpl = vi.fn(async () => new Response('<html>502</html>', { status: 502 }));

    await expect(clientWith(fetchImpl as unknown as typeof fetch).projects()).rejects.toMatchObject({
      status: 502,
      code: 'UNKNOWN',
    });
  });

  it('treats an ok:false body as an error even with a 200 status', async () => {
    const fetchImpl = vi.fn(async () => json({ ok: false, code: 'CONFLICT', error: 'clash' }));
    await expect(clientWith(fetchImpl as unknown as typeof fetch).projects()).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });
});

describe('me', () => {
  it('returns the user when signed in', async () => {
    const fetchImpl = vi.fn(async () =>
      json({ ok: true, user: { id: 'usr_1', email: 'a@b.com', emailVerified: true } }),
    );
    expect(await clientWith(fetchImpl as unknown as typeof fetch).me()).toMatchObject({
      email: 'a@b.com',
    });
  });

  it('returns null rather than throwing when signed out', async () => {
    // Signed-out is an ordinary state for an app on launch, not an exception.
    const fetchImpl = vi.fn(async () => json({ ok: false, code: 'UNAUTHORIZED', error: 'nope' }, 401));
    expect(await clientWith(fetchImpl as unknown as typeof fetch).me()).toBeNull();
  });

  it('still propagates a non-auth failure', async () => {
    const fetchImpl = vi.fn(async () => json({ ok: false, code: 'UNKNOWN', error: 'boom' }, 500));
    await expect(clientWith(fetchImpl as unknown as typeof fetch).me()).rejects.toThrow(ApiError);
  });
});

describe('moments', () => {
  it('filters by decision when asked', async () => {
    const fetchImpl = vi.fn(async () => json({ ok: true, moments: [] }));
    await clientWith(fetchImpl as unknown as typeof fetch).moments('prj_1', true);
    expect(vi.mocked(fetchImpl).mock.calls[0]?.[0]).toContain('included=true');
  });

  it('sends a tri-state decision, including null', async () => {
    const fetchImpl = vi.fn(async () => json({ ok: true, moment: { id: 'mom_1' } }));
    await clientWith(fetchImpl as unknown as typeof fetch).decideMoment('prj_1', 'mom_1', null);

    const init = vi.mocked(fetchImpl).mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(init.body as string)).toEqual({ included: null });
  });
});

describe('setToken', () => {
  it('applies to later requests', async () => {
    const fetchImpl = vi.fn(async () => json({ ok: true, projects: [] }));
    const client = createClient({
      baseUrl: 'https://reeleel.test',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    client.setToken('fresh');
    await client.projects();

    const init = vi.mocked(fetchImpl).mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer fresh');
  });
});
