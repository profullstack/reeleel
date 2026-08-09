/**
 * Typed client for the ReelEel HTTP API.
 *
 * Deliberately free of Node and DOM specifics — it uses only `fetch`, which
 * React Native, browsers and Node 18+ all provide. That is what lets the
 * native app, the web app and any script share one definition of the API
 * instead of three drifting copies.
 *
 * Type shapes are declared here rather than imported from @reeleel/core so a
 * React Native bundle never pulls in SQLite, FFmpeg or the filesystem.
 */

export interface ProjectSummary {
  id: string;
  name: string;
  sport: string;
  root: string;
  opponent?: string;
  gameDate?: string;
  videoCount: number;
  athleteCount: number;
  momentCount: number;
  exists: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SourceVideo {
  id: string;
  path: string;
  probe: {
    durationSeconds: number;
    video?: { width: number; height: number; fps: number };
  } | null;
  proxyPath: string | null;
}

export interface Athlete {
  id: string;
  name: string | null;
  jerseyNumber: string | null;
  team: string | null;
  isFocal: boolean;
}

export interface SuggestedMoment {
  id: string;
  start: number;
  end: number;
  score: number;
  reasons: string[];
  included: boolean | null;
  favorite: boolean;
  title: string | null;
}

export interface Job {
  id: string;
  kind: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'canceled';
  stage: string | null;
  progress: number;
  error: string | null;
}

export interface CurrentUser {
  id: string;
  email: string;
  emailVerified: boolean;
}

export interface HealthCheck {
  name: string;
  status: 'ok' | 'warn' | 'fail';
  detail: string;
  hint?: string;
}

/** Mirrors the API's error envelope so callers can branch on a stable code. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly hint: string | undefined;

  constructor(status: number, code: string, message: string, hint?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.hint = hint;
  }

  /** True when signing in again is the fix. */
  get isAuthError(): boolean {
    return this.status === 401 || this.code === 'UNAUTHORIZED';
  }

  get isNotFound(): boolean {
    return this.status === 404;
  }
}

export interface ClientOptions {
  baseUrl: string;
  /** Service token, or a session token obtained elsewhere. */
  token?: string | undefined;
  /** Swappable for tests and for platforms with a custom fetch. */
  fetchImpl?: typeof fetch;
  /** Milliseconds before a request is abandoned. */
  timeoutMs?: number;
}

interface Envelope {
  ok?: boolean;
  code?: string;
  error?: string;
  hint?: string;
}

export class ReelEelClient {
  private readonly baseUrl: string;
  private token: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: ClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.token = options.token;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  setToken(token: string | undefined): void {
    this.token = token;
  }

  private async request<T>(
    path: string,
    init: { method?: string; body?: unknown; signal?: AbortSignal } = {},
  ): Promise<T> {
    const controller = new AbortController();
    // A mobile client on a flaky connection must fail rather than hang forever.
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    init.signal?.addEventListener('abort', () => controller.abort(), { once: true });

    const headers: Record<string, string> = { accept: 'application/json' };
    if (this.token !== undefined) headers['authorization'] = `Bearer ${this.token}`;
    if (init.body !== undefined) headers['content-type'] = 'application/json';

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: init.method ?? 'GET',
        headers,
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        signal: controller.signal,
      });
    } catch (cause) {
      const aborted = cause instanceof Error && cause.name === 'AbortError';
      throw new ApiError(
        0,
        aborted ? 'TIMEOUT' : 'NETWORK',
        aborted ? 'The request timed out.' : 'Could not reach the server.',
      );
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();
    let payload: (Envelope & Record<string, unknown>) | null = null;
    try {
      payload = text.length > 0 ? (JSON.parse(text) as Envelope & Record<string, unknown>) : null;
    } catch {
      payload = null;
    }

    if (!response.ok || payload?.ok === false) {
      throw new ApiError(
        response.status,
        payload?.code ?? 'UNKNOWN',
        payload?.error ?? `Request failed (${response.status})`,
        payload?.hint,
      );
    }
    return (payload ?? {}) as T;
  }

  health(): Promise<{ ok: boolean; service: string; version: string }> {
    return this.request('/api/health');
  }

  /**
   * Exchanges credentials for a session token and starts using it. The token is
   * the same session secret a browser keeps in a cookie, so signing out on one
   * device behaves the same everywhere.
   */
  async login(email: string, password: string): Promise<{ token: string; user: CurrentUser }> {
    const result = await this.request<{ token: string; user: CurrentUser }>('/api/login', {
      method: 'POST',
      body: { email, password },
    });
    this.token = result.token;
    return result;
  }

  /** null when nobody is signed in — not an error. */
  async me(): Promise<CurrentUser | null> {
    try {
      const result = await this.request<{ user: CurrentUser | null }>('/api/me');
      return result.user;
    } catch (error) {
      if (error instanceof ApiError && error.isAuthError) return null;
      throw error;
    }
  }

  async doctor(): Promise<{ status: string; checks: HealthCheck[] }> {
    return this.request('/api/doctor');
  }

  async projects(): Promise<ProjectSummary[]> {
    const result = await this.request<{ projects: ProjectSummary[] }>('/api/projects');
    return result.projects;
  }

  async project(ref: string): Promise<ProjectSummary> {
    const result = await this.request<{ project: ProjectSummary }>(
      `/api/projects/${encodeURIComponent(ref)}`,
    );
    return result.project;
  }

  async createProject(input: {
    name: string;
    sport?: string;
    opponent?: string;
    gameDate?: string;
  }): Promise<ProjectSummary> {
    const result = await this.request<{ project: ProjectSummary }>('/api/projects', {
      method: 'POST',
      body: input,
    });
    return result.project;
  }

  async updateProject(ref: string, patch: Record<string, unknown>): Promise<ProjectSummary> {
    const result = await this.request<{ project: ProjectSummary }>(
      `/api/projects/${encodeURIComponent(ref)}`,
      { method: 'PATCH', body: patch },
    );
    return result.project;
  }

  async deleteProject(ref: string, deleteFiles = false): Promise<void> {
    await this.request(
      `/api/projects/${encodeURIComponent(ref)}?deleteFiles=${deleteFiles ? 'true' : 'false'}`,
      { method: 'DELETE' },
    );
  }

  async videos(ref: string): Promise<SourceVideo[]> {
    const result = await this.request<{ videos: SourceVideo[] }>(
      `/api/projects/${encodeURIComponent(ref)}/videos`,
    );
    return result.videos;
  }

  async athletes(ref: string): Promise<Athlete[]> {
    const result = await this.request<{ athletes: Athlete[] }>(
      `/api/projects/${encodeURIComponent(ref)}/athletes`,
    );
    return result.athletes;
  }

  async addAthlete(ref: string, input: Partial<Athlete> & { focal?: boolean }): Promise<Athlete> {
    const result = await this.request<{ athlete: Athlete }>(
      `/api/projects/${encodeURIComponent(ref)}/athletes`,
      { method: 'POST', body: input },
    );
    return result.athlete;
  }

  async moments(ref: string, included?: boolean): Promise<SuggestedMoment[]> {
    const query = included === undefined ? '' : `?included=${included ? 'true' : 'false'}`;
    const result = await this.request<{ moments: SuggestedMoment[] }>(
      `/api/projects/${encodeURIComponent(ref)}/moments${query}`,
    );
    return result.moments;
  }

  async decideMoment(
    ref: string,
    momentId: string,
    included: boolean | null,
  ): Promise<SuggestedMoment> {
    const result = await this.request<{ moment: SuggestedMoment }>(
      `/api/projects/${encodeURIComponent(ref)}/moments/${momentId}`,
      { method: 'PATCH', body: { included } },
    );
    return result.moment;
  }

  async jobs(ref: string): Promise<Job[]> {
    const result = await this.request<{ jobs: Job[] }>(
      `/api/projects/${encodeURIComponent(ref)}/jobs`,
    );
    return result.jobs;
  }
}

export const createClient = (options: ClientOptions): ReelEelClient => new ReelEelClient(options);
