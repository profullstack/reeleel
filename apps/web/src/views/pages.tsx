/** @jsxImportSource hono/jsx */
import type { FC } from 'hono/jsx';

import type {
  Athlete,
  Check,
  Clip,
  ExportRecord,
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

export const ProjectsPage: FC<{
  projects: ProjectSummary[];
  sports: { id: string; name: string }[];
  flash: Flash;
}> = ({ projects, sports, flash }) => (
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
        <div class="field">
          <label for="sport">Sport</label>
          {/* Populated from the plugin registry, so a new sport plugin shows up
              here without touching this template. */}
          <select
            id="sport"
            name="sport"
            style="font:inherit;padding:.45rem .6rem;border-radius:.4rem;border:1px solid var(--line);background:var(--bg);color:inherit;width:100%"
          >
            {sports.map((sport) => (
              <option key={sport.id} value={sport.id} selected={sport.id === 'soccer'}>
                {sport.name}
              </option>
            ))}
          </select>
        </div>
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
  /** Newest first, so "the latest export" is simply the first one. */
  exports: ExportRecord[];
  /** Uploaded background music, by filename. */
  music: string[];
  flash: Flash;
}

export const ProjectPage: FC<ProjectView> = ({
  project,
  videos,
  athletes,
  moments,
  clips,
  jobs,
  exports,
  music,
  flash,
}) => {
  const base = `/projects/${encodeURIComponent(project.id)}`;
  const kept = moments.filter((m) => m.included === true).length;
  // Bound to a track — not merely existing, and not merely flagged focal. The
  // track is what scoring reads.
  const identified = athletes.some((athlete) => athlete.focalTrackId !== null);

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

        {/* The realtime uploader replaces the contents of this element on
            mount. What is rendered here is the no-JavaScript fallback: an
            ordinary multipart post, which the server streams to disk just the
            same. The upgrade is resumability and a status bar, not the ability
            to upload at all. */}
        <div id="upload-panel" data-base={base} style="margin-top:.75rem">
          <form method="post" action={`${base}/videos`} enctype="multipart/form-data">
            <div class="field">
              <label for="file">Upload a file</label>
              <input
                id="file"
                name="file"
                type="file"
                accept="video/mp4,video/quicktime,video/x-matroska,video/webm"
              />
            </div>
            <button type="submit">Import</button>
          </form>
        </div>

        {/* A path for a local instance, where the footage is already on this
            machine and should stay where it is. */}
        <form method="post" action={`${base}/videos`} style="margin-top:1rem">
          <div class="field">
            <label for="path">…or import a path already on the server</label>
            <input id="path" name="path" type="text" placeholder="/data/footage/game.mp4" />
          </div>
          <button type="submit">Import path</button>
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

      {/* The one irreducibly manual step: a detector cannot know which player
          is yours. Until an athlete is bound to a track, scoring has no focal
          signal and cannot reach its own threshold. Replaced by a grid of
          cropped frames on mount; without JavaScript it stays a plain form. */}
      {/* Open precisely when it is the outstanding step. This was inverted:
          it opened once an athlete existed — that is, once you had already done
          the hard part — and stayed shut for the person who had done nothing
          yet and needed it most. */}
      <details class="card" open={!identified}>
        <summary>
          Identify your athlete{identified ? '' : ' — required for any suggestions'}
        </summary>
        <div id="identify-athlete" data-base={base} style="margin-top:.75rem">
          <p class="muted">
            Run analysis first, then pick which tracked player is your athlete. Without that,
            scoring has nothing to follow and will suggest nothing.
          </p>
          {/* `new` creates the athlete on submit, so the no-JS path has no
              prerequisite either. */}
          <form method="post" action={`${base}/athletes/${athletes[0]?.id ?? 'new'}/track`}>
            <div class="field">
              <label for="trackId">Track id</label>
              <input id="trackId" name="trackId" type="text" placeholder="trk_…" />
            </div>
            <button type="submit">Bind to {athletes[0]?.name ?? 'my athlete'}</button>
          </form>
        </div>
      </details>

      <h2>Analysis</h2>
      <form method="post" action={`${base}/analyze`} class="card">
        <div class="row">
          {/* Analysis used to run over every imported video, which makes one bad
              file take the whole run down with it and re-analyses footage that
              was already done. Newest first and selected by default, because
              the thing just imported is almost always the thing to analyse. */}
          <label for="videoId" style="margin:0">
            Footage
          </label>
          <select
            id="videoId"
            name="videoId"
            style="font:inherit;padding:.35rem;border-radius:.4rem;max-width:18rem"
          >
            {[...videos].reverse().map((video, index) => (
              <option key={video.id} value={video.id} selected={index === 0}>
                {video.path.split('/').pop()}
                {index === 0 ? ' (latest)' : ''}
              </option>
            ))}
            <option value="all">All footage</option>
          </select>

          <label for="preset" style="margin:0">
            Preset
          </label>
          <select id="preset" name="preset" style="font:inherit;padding:.35rem;border-radius:.4rem">
            <option value="fast">fast</option>
            <option value="balanced" selected>
              balanced
            </option>
            <option value="accurate">accurate</option>
            {/* Slices each frame so the detector can resolve the ball. Five
                inferences per frame instead of one, so the cost is stated
                rather than discovered. */}
            <option value="thorough">thorough — sees the ball, ~5x slower</option>
          </select>
          <button type="submit" disabled={videos.length === 0}>
            Analyze game
          </button>
        </div>
        {videos.length === 0 ? <p class="muted">Import footage first.</p> : null}
      </form>

      {/* Replaced by the live SSE log on mount. What is rendered here is the
          no-JavaScript view: the same jobs, including — unlike before — the
          reason a failed one failed. */}
      <div id="job-log" data-base={base}>
        {jobs.length === 0 ? null : (
          <table>
            <thead>
              <tr>
                <th>Job</th>
                <th>Status</th>
                <th>Stage</th>
                <th>Progress</th>
                <th>Detail</th>
                <th />
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
                  <td class="muted">{job.error ?? '—'}</td>
                  <td>
                    {/* The same routes the live log posts to, so stop and
                        replay work without JavaScript too. */}
                    <div class="row">
                      {job.status === 'running' || job.status === 'queued' ? (
                        <form method="post" action={`${base}/jobs/${job.id}/cancel`}>
                          <button type="submit">Stop</button>
                        </form>
                      ) : (
                        <>
                          <form method="post" action={`${base}/jobs/${job.id}/retry`}>
                            <button type="submit">Replay</button>
                          </form>
                          <form method="post" action={`${base}/jobs/${job.id}/delete`}>
                            <button type="submit">Remove</button>
                          </form>
                        </>
                      )}
                    </div>
                  </td>
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
      </div>

      <h2>Suggested moments</h2>
      {/* The honest answer to "is it even following the right kid" — and the
          place to fix it when it is not. */}
      <p class="muted">
        <a href={`${base}/review`}>See what the detector sees</a> — every track over the whole
        game, and click your athlete to identify them.
      </p>
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
                {/* Watch it here. Deciding whether a five-second suggestion is
                    any good used to mean keeping it, building clips, exporting
                    and downloading a reel. `#t=start,end` plays exactly the
                    span; `preload="none"` means nothing is fetched until the
                    moment is opened, so a page of suggestions costs nothing. */}
                {moment.videoId === null ? null : (
                  /* Visible, not folded away. Twice now something necessary has
                     been hidden behind a <summary> and gone unnoticed for
                     hours; `preload="none"` already means an unwatched player
                     costs nothing, so there is no reason to hide it. The island
                     overlays detection boxes on this element when it loads. */
                  <div
                    class="moment-player"
                    data-video={`${base}/videos/${moment.videoId}/tracks`}
                    data-start={String(moment.start)}
                    data-end={String(moment.end)}
                    style="position:relative;margin-top:.5rem"
                  >
                    <video
                      controls
                      preload="none"
                      playsinline
                      style="width:100%;max-height:60vh;border-radius:.4rem;background:#000;display:block"
                      src={`${base}/videos/${moment.videoId}/stream#t=${moment.start.toFixed(2)},${moment.end.toFixed(2)}`}
                    />
                  </div>
                )}
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
          <div class="row" style="margin-top:.5rem">
            {/* The bed sits well under the game: the crowd and the shoes are
                most of why a clip is worth keeping. */}
            <label for="music" style="margin:0">
              Music
            </label>
            <select id="music" name="music" style="font:inherit;padding:.35rem;border-radius:.4rem">
              <option value="none">none</option>
              {music.map((track) => (
                <option value={track} key={track}>
                  {track}
                </option>
              ))}
            </select>
            <label for="musicVolume" style="margin:0">
              Level
            </label>
            <input
              id="musicVolume"
              name="musicVolume"
              type="number"
              min="0"
              max="1"
              step="0.02"
              value="0.18"
              style="max-width:5rem"
            />
            <label for="fadeSeconds" style="margin:0">
              Fade
            </label>
            <input
              id="fadeSeconds"
              name="fadeSeconds"
              type="number"
              min="0"
              max="3"
              step="0.05"
              value="0.35"
              style="max-width:5rem"
            />
            <span class="muted">seconds, each end of every clip</span>
          </div>
        </form>

        <form
          method="post"
          action={`${base}/music`}
          enctype="multipart/form-data"
          class="row"
          style="margin-top:.5rem"
        >
          <input type="file" name="music" accept="audio/*" />
          <button type="submit">Add music</button>
          <span class="muted">
            {music.length === 0 ? 'No music uploaded yet.' : `${music.length} track(s) available.`}
          </span>
        </form>
      </div>

      {/* Exports were written to the server's disk and never shown, so a render
          that replaced an earlier one did so invisibly. Newest first; every
          version is kept and downloadable. */}
      {exports.length === 0 ? null : (
        <table>
          <thead>
            <tr>
              <th>Export</th>
              <th>Aspect</th>
              <th>Created</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {exports.map((record, index) => (
              <tr key={record.id}>
                <td>
                  <code>{record.path.split('/').pop()}</code>
                  {index === 0 ? <span class="pill keep"> latest</span> : null}
                </td>
                <td>{record.aspect}</td>
                <td class="muted">{record.createdAt.replace('T', ' ').slice(0, 16)}</td>
                <td>
                  <div class="row">
                    <a href={`${base}/exports/${record.id}/download`}>Download</a>
                    <form method="post" action={`${base}/exports/${record.id}/delete`}>
                      <button type="submit">Delete</button>
                    </form>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

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
