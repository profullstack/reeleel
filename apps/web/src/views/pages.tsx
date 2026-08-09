/** @jsxImportSource hono/jsx */
import type { FC } from 'hono/jsx';

import type {
  Athlete,
  Check,
  Clip,
  Job,
  ProjectSummary,
  SourceVideo,
  SuggestedMoment,
} from '@reeleel/core';

import { Layout } from './Layout.js';

const duration = (seconds: number): string => {
  const total = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(total / 60);
  return `${minutes}:${String(total % 60).padStart(2, '0')}`;
};

export interface Flash {
  ok?: string | undefined;
  err?: string | undefined;
}

export const Notice: FC<{ flash: Flash }> = ({ flash }) => (
  <>
    {flash.ok === undefined ? null : <p class="notice">{flash.ok}</p>}
    {flash.err === undefined ? null : (
      <p class="notice error" role="alert">
        {flash.err}
      </p>
    )}
  </>
);

export const ProjectsPage: FC<{ projects: ProjectSummary[]; flash: Flash }> = ({
  projects,
  flash,
}) => (
  <Layout title="Projects">
    <h1>Projects</h1>
    <Notice flash={flash} />

    <details class="card" open={projects.length === 0}>
      <summary>New project</summary>
      <form method="post" action="/projects" style="margin-top:.75rem">
        <div class="field">
          <label for="name">Name</label>
          <input id="name" name="name" type="text" required placeholder="Spring Cup QF" />
        </div>
        <div class="field">
          <label for="opponent">Opponent</label>
          <input id="opponent" name="opponent" type="text" placeholder="Rivals" />
        </div>
        <div class="field">
          <label for="gameDate">Game date</label>
          <input id="gameDate" name="gameDate" type="text" placeholder="2026-05-01" />
        </div>
        <input type="hidden" name="sport" value="soccer" />
        <button type="submit">Create project</button>
      </form>
    </details>

    {projects.length === 0 ? (
      <p class="empty">No projects yet.</p>
    ) : (
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Sport</th>
            <th>Videos</th>
            <th>Moments</th>
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
                {project.exists ? null : <span class="pill reject"> missing</span>}
              </td>
              <td>{project.sport}</td>
              <td>{project.videoCount}</td>
              <td>{project.momentCount}</td>
            </tr>
          ))}
        </tbody>
      </table>
    )}
  </Layout>
);

export interface ProjectView {
  project: ProjectSummary;
  videos: SourceVideo[];
  athletes: Athlete[];
  moments: SuggestedMoment[];
  clips: Clip[];
  jobs: Job[];
  flash: Flash;
}

export const ProjectPage: FC<ProjectView> = ({
  project,
  videos,
  athletes,
  moments,
  clips,
  jobs,
  flash,
}) => {
  const base = `/projects/${encodeURIComponent(project.id)}`;
  const kept = moments.filter((m) => m.included === true).length;

  return (
    <Layout title={project.name}>
      <h1>{project.name}</h1>
      <p class="muted">
        {project.sport}
        {project.opponent === undefined ? '' : ` · vs ${project.opponent}`}
        {project.gameDate === undefined ? '' : ` · ${project.gameDate}`}
      </p>
      <Notice flash={flash} />

      <h2>Footage</h2>
      {videos.length === 0 ? (
        <p class="empty">Nothing imported yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>File</th>
              <th>Duration</th>
              <th>Resolution</th>
              <th />
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
                <td>
                  <form method="post" action={`${base}/videos/${video.id}/delete`}>
                    <button type="submit">Remove</button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <details class="card" open={videos.length === 0}>
        <summary>Import footage</summary>
        {/* Upload for a hosted instance; a path for a local one, where the
            footage is already on this machine and should stay put. */}
        <form method="post" action={`${base}/videos`} enctype="multipart/form-data" style="margin-top:.75rem">
          <div class="field">
            <label for="file">Upload a file</label>
            <input id="file" name="file" type="file" accept="video/mp4,video/quicktime,video/x-matroska,video/webm" />
          </div>
          <div class="field">
            <label for="path">…or a path on the server</label>
            <input id="path" name="path" type="text" placeholder="/data/footage/game.mp4" />
          </div>
          <button type="submit">Import</button>
        </form>
      </details>

      <h2>Athlete to follow</h2>
      {athletes.length === 0 ? (
        <p class="empty">Nobody yet. Analysis needs someone to follow.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th />
              <th>Name</th>
              <th>Number</th>
              <th>Team</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {athletes.map((athlete) => (
              <tr key={athlete.id}>
                <td>{athlete.isFocal ? <span class="pill keep">following</span> : null}</td>
                <td>{athlete.name ?? <span class="muted">(unnamed)</span>}</td>
                <td>{athlete.jerseyNumber ?? '—'}</td>
                <td>{athlete.team ?? '—'}</td>
                <td>
                  <div class="row">
                    {athlete.isFocal ? null : (
                      <form method="post" action={`${base}/athletes/${athlete.id}/focus`}>
                        <button type="submit">Follow</button>
                      </form>
                    )}
                    <form method="post" action={`${base}/athletes/${athlete.id}/delete`}>
                      <button type="submit">Remove</button>
                    </form>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <details class="card" open={athletes.length === 0}>
        <summary>Add an athlete</summary>
        <form method="post" action={`${base}/athletes`} style="margin-top:.75rem">
          <div class="field">
            <label for="aname">Name</label>
            <input id="aname" name="name" type="text" placeholder="Sam" />
          </div>
          <div class="field">
            <label for="number">Jersey number</label>
            <input id="number" name="number" type="text" placeholder="7" />
          </div>
          <div class="field">
            <label for="team">Team</label>
            <input id="team" name="team" type="text" />
          </div>
          <label>
            <input type="checkbox" name="focal" checked /> Follow this athlete
          </label>
          <p class="muted">
            ReelEel identifies athletes by appearance and position, never by face.
          </p>
          <button type="submit">Add athlete</button>
        </form>
      </details>

      <h2>Analysis</h2>
      <form method="post" action={`${base}/analyze`} class="card">
        <div class="row">
          <label for="preset" style="margin:0">
            Preset
          </label>
          <select id="preset" name="preset" style="font:inherit;padding:.35rem;border-radius:.4rem">
            <option value="fast">fast</option>
            <option value="balanced" selected>
              balanced
            </option>
            <option value="accurate">accurate</option>
          </select>
          <button type="submit" disabled={videos.length === 0}>
            Analyze game
          </button>
        </div>
        {videos.length === 0 ? <p class="muted">Import footage first.</p> : null}
      </form>

      {jobs.length === 0 ? null : (
        <table>
          <thead>
            <tr>
              <th>Job</th>
              <th>Status</th>
              <th>Stage</th>
              <th>Progress</th>
            </tr>
          </thead>
          <tbody>
            {jobs.slice(0, 5).map((job) => (
              <tr key={job.id}>
                <td>{job.kind}</td>
                <td>
                  <span class={`pill ${job.status === 'completed' ? 'keep' : job.status === 'failed' ? 'reject' : ''}`}>
                    {job.status}
                  </span>
                </td>
                <td class="muted">{job.stage ?? '—'}</td>
                <td>{Math.round(job.progress * 100)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {jobs.some((job) => job.status === 'running' || job.status === 'queued') ? (
        <p class="muted">
          Analysis is running. <a href={base}>Refresh</a> for progress.
        </p>
      ) : null}

      <h2>Suggested moments</h2>
      {moments.length === 0 ? (
        <p class="empty">Nothing suggested yet — run analysis.</p>
      ) : (
        <>
          <p class="muted">
            {kept} of {moments.length} kept
          </p>
          {/* Server-rendered so review works without JS; the island upgrades
              this in place when the bundle loads. */}
          <div id="moment-review" data-project={project.id} data-moments={JSON.stringify(moments)}>
            {moments.map((moment) => (
              <div class="card" key={moment.id}>
                <div class="row">
                  <strong>
                    {duration(moment.start)} → {duration(moment.end)}
                  </strong>
                  <span class="pill">score {moment.score.toFixed(2)}</span>
                  <span class="grow muted">{moment.reasons.join(', ')}</span>
                  <span
                    class={`pill ${moment.included === true ? 'keep' : moment.included === false ? 'reject' : ''}`}
                  >
                    {moment.included === true ? 'keep' : moment.included === false ? 'reject' : 'undecided'}
                  </span>
                  <form method="post" action={`${base}/moments/${moment.id}/decide`}>
                    <input type="hidden" name="decision" value="keep" />
                    <button type="submit">Keep</button>
                  </form>
                  <form method="post" action={`${base}/moments/${moment.id}/decide`}>
                    <input type="hidden" name="decision" value="reject" />
                    <button type="submit">Reject</button>
                  </form>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      <h2>Reel</h2>
      <div class="card">
        <div class="row">
          <form method="post" action={`${base}/clips`}>
            <button type="submit" disabled={kept === 0}>
              Build clips from {kept} kept moment(s)
            </button>
          </form>
          <span class="muted">{clips.length} clip(s) ready</span>
        </div>
        <form method="post" action={`${base}/export`} style="margin-top:.75rem">
          <div class="row">
            <input name="name" type="text" value="highlights" style="max-width:12rem" />
            <select name="aspect" style="font:inherit;padding:.35rem;border-radius:.4rem">
              <option value="16:9">16:9</option>
              <option value="9:16">9:16</option>
              <option value="1:1">1:1</option>
            </select>
            <button type="submit" disabled={clips.length === 0}>
              Export reel
            </button>
          </div>
        </form>
      </div>

      <h2>Settings</h2>
      <details class="card">
        <summary>Edit project</summary>
        <form method="post" action={`${base}/update`} style="margin-top:.75rem">
          <div class="field">
            <label for="pname">Name</label>
            <input id="pname" name="name" type="text" value={project.name} />
          </div>
          <div class="field">
            <label for="popponent">Opponent</label>
            <input id="popponent" name="opponent" type="text" value={project.opponent ?? ''} />
          </div>
          <div class="field">
            <label for="pdate">Game date</label>
            <input id="pdate" name="gameDate" type="text" value={project.gameDate ?? ''} />
          </div>
          <button type="submit">Save</button>
        </form>
      </details>
      <details class="card">
        <summary>Delete project</summary>
        <form method="post" action={`${base}/delete`} style="margin-top:.75rem">
          <label>
            <input type="checkbox" name="deleteFiles" /> Also delete the files on disk (cannot be
            undone)
          </label>
          <button type="submit" style="margin-top:.5rem">
            Delete project
          </button>
        </form>
      </details>
    </Layout>
  );
};

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
