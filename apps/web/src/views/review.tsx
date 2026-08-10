/** @jsxImportSource hono/jsx */
import type { FC } from 'hono/jsx';

import type { ProjectSummary, SourceVideo } from '@reeleel/core';

import { Layout } from './Layout.js';
import { Notice } from './pages.js';
import type { Flash } from './pages.js';

/**
 * Everything the detector tracked, over the whole game, scrubbable.
 *
 * The moment players answer "was this five seconds any good". They cannot
 * answer "is it following the right child", because to ask that you have to be
 * able to go to a point where you know your kid is on screen and look.
 *
 * The picker could not answer it either: it offers the *longest* tracks, and
 * on footage that fragments into thousands of them the longest are spectators,
 * a coach, and the referee — "just random kids", which is exactly what it
 * looked like. Here you scrub to a moment you recognise and click the box
 * around your child, which is the one identification instruction that needs no
 * explanation.
 */
export const ReviewPage: FC<{
  project: ProjectSummary;
  video: SourceVideo | undefined;
  athleteName: string | null;
  trackCount: number;
  flash: Flash;
}> = ({ project, video, athleteName, trackCount, flash }) => {
  const base = `/projects/${encodeURIComponent(project.id)}`;

  return (
    <Layout title={`Review — ${project.name}`}>
      <h1>What the detector sees</h1>
      <p class="muted">
        <a href={base}>{project.name}</a> · {trackCount} track(s)
        {athleteName === null ? ' · no athlete identified' : ` · following ${athleteName}`}
      </p>
      <Notice flash={flash} />

      {video === undefined ? (
        <p class="empty">No footage imported yet.</p>
      ) : (
        <>
          <div class="card">
            {/* Written as the three things to do, in order. "Scrub" is editing
                jargon and was not understood; "drag the progress bar" is the
                same instruction and needs no translation. */}
            <ol class="muted" style="margin:0 0 .75rem 1.1rem;padding:0">
              <li>Drag the progress bar until you can see your athlete clearly.</li>
              <li>
                Press <strong>Identify my athlete</strong> — the video pauses.
              </li>
              <li>
                <strong>Click the box drawn around them.</strong> That binds them and re-scores in
                seconds, without re-running detection.
              </li>
            </ol>
            <div
              id="review-surface"
              data-tracks={`${base}/videos/${video.id}/tracks`}
              data-bind={`${base}/athletes/new/track`}
              data-duration={String(video.probe?.durationSeconds ?? 0)}
              style="position:relative"
            >
              <video
                controls
                preload="metadata"
                playsinline
                style="width:100%;max-height:70vh;border-radius:.4rem;background:#000;display:block"
                src={`${base}/videos/${video.id}/stream`}
              />
            </div>
          </div>

          <p class="muted">
            Boxes are drawn from stored tracks, so this is exactly what scoring reads — not a
            re-run and not an approximation. Green is your athlete. Grey boxes are other people.
          </p>
        </>
      )}
    </Layout>
  );
};
