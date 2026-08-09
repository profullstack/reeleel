/** @jsxImportSource hono/jsx */
import type { FC } from 'hono/jsx';

import type { Check, ProjectSummary, SourceVideo, SuggestedMoment } from '@reeleel/core';

import { Layout } from './Layout.js';

const duration = (seconds: number): string => {
  const total = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(total / 60);
  return `${minutes}:${String(total % 60).padStart(2, '0')}`;
};

export const ProjectsPage: FC<{ projects: ProjectSummary[] }> = ({ projects }) => (
  <Layout title="Projects">
    <h1>Projects</h1>
    <p class="muted">Every game stays in its own folder on this machine.</p>

    {projects.length === 0 ? (
      <p class="empty">
        No projects yet. Create one with <code>reeleel project create "My Game"</code>.
      </p>
    ) : (
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Sport</th>
            <th>Videos</th>
            <th>Moments</th>
            <th>Path</th>
          </tr>
        </thead>
        <tbody>
          {projects.map((project) => (
            <tr key={project.id}>
              <td>
                {project.exists ? (
                  <a href={`/projects/${encodeURIComponent(project.id)}`}>{project.name}</a>
                ) : (
                  <span class="muted">{project.name}</span>
                )}
              </td>
              <td>{project.sport}</td>
              <td>{project.videoCount}</td>
              <td>{project.momentCount}</td>
              <td>
                <code class="muted">{project.root}</code>
                {project.exists ? null : <span class="pill reject"> missing</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    )}
  </Layout>
);

export const ProjectPage: FC<{
  project: ProjectSummary;
  videos: SourceVideo[];
  moments: SuggestedMoment[];
}> = ({ project, videos, moments }) => (
  <Layout title={project.name}>
    <h1>{project.name}</h1>
    <p class="muted">
      {project.sport}
      {project.opponent === undefined ? '' : ` · vs ${project.opponent}`}
      {project.gameDate === undefined ? '' : ` · ${project.gameDate}`}
    </p>

    <h2>Footage</h2>
    {videos.length === 0 ? (
      <p class="empty">
        Nothing imported. Run <code>reeleel import game.mp4</code>.
      </p>
    ) : (
      <table>
        <thead>
          <tr>
            <th>File</th>
            <th>Duration</th>
            <th>Resolution</th>
            <th>Proxy</th>
          </tr>
        </thead>
        <tbody>
          {videos.map((video) => (
            <tr key={video.id}>
              <td>
                <code>{video.path.split('/').pop()}</code>
              </td>
              <td>{duration(video.probe?.durationSeconds ?? 0)}</td>
              <td>
                {video.probe?.video === undefined
                  ? '—'
                  : `${video.probe.video.width}×${video.probe.video.height}`}
              </td>
              <td class="muted">{video.proxyPath === null ? 'not built' : 'ready'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    )}

    <h2>Suggested moments</h2>
    {moments.length === 0 ? (
      <p class="empty">
        Nothing suggested yet. Run <code>reeleel analyze</code>.
      </p>
    ) : (
      // Server-rendered so the list is readable without JS; the island below
      // upgrades it in place for accept/reject.
      <div
        id="moment-review"
        data-project={project.id}
        data-moments={JSON.stringify(moments)}
      >
        {moments.map((moment) => (
          <div class="card" key={moment.id}>
            <div class="row">
              <strong>
                {duration(moment.start)} → {duration(moment.end)}
              </strong>
              <span class="pill">score {moment.score.toFixed(2)}</span>
              <span class="grow muted">{moment.reasons.join(', ')}</span>
              <span class={`pill ${moment.included === true ? 'keep' : moment.included === false ? 'reject' : ''}`}>
                {moment.included === true ? 'keep' : moment.included === false ? 'reject' : 'undecided'}
              </span>
            </div>
          </div>
        ))}
      </div>
    )}
  </Layout>
);

export const DoctorPage: FC<{ checks: Check[]; status: string }> = ({ checks, status }) => (
  <Layout title="Doctor">
    <h1>Doctor</h1>
    <p class="muted">Whether this machine can run the full pipeline. Overall: {status}</p>
    {checks.map((check) => (
      <div class="card" key={check.name}>
        <div class="row">
          <strong>{check.name}</strong>
          <span
            class={`pill ${check.status === 'ok' ? 'keep' : check.status === 'fail' ? 'reject' : ''}`}
          >
            {check.status}
          </span>
          <span class="grow muted">{check.detail}</span>
        </div>
        {check.hint === undefined ? null : <p class="muted">{check.hint}</p>}
      </div>
    ))}
  </Layout>
);

export const LoginPage: FC<{ error?: string | undefined; next?: string | undefined }> = ({
  error,
  next,
}) => (
  <Layout title="Sign in">
    <h1>Sign in</h1>
    <p class="muted">
      This ReelEel instance is protected. Enter its access token to continue.
    </p>
    {error === undefined ? null : (
      <p class="pill reject" role="alert">
        {error}
      </p>
    )}
    <form method="post" action="/login" class="card">
      <input type="hidden" name="next" value={next ?? '/'} />
      <div class="row">
        <label for="token" class="muted">
          Access token
        </label>
        <input
          id="token"
          name="token"
          type="password"
          autocomplete="current-password"
          required
          class="grow"
          style="font: inherit; padding: .4rem .6rem; border-radius: .4rem; border: 1px solid var(--line); background: var(--bg); color: inherit;"
        />
        <button type="submit">Sign in</button>
      </div>
    </form>
    <p class="muted">
      The token is the <code>REELEEL_AUTH_TOKEN</code> this server was started with. Running
      ReelEel on your own machine needs no token at all.
    </p>
  </Layout>
);

export const ErrorPage: FC<{ message: string; hint?: string | undefined }> = ({ message, hint }) => (
  <Layout title="Error">
    <h1>Something went wrong</h1>
    <p>{message}</p>
    {hint === undefined ? null : <p class="muted">{hint}</p>}
    <p>
      <a href="/">Back to projects</a>
    </p>
  </Layout>
);
