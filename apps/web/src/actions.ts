import { createReadStream, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';

import type { Context, Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

import { originAllowed, ownerFor, scopeFor } from '@reeleel/api';
import {
  addAthlete,
  addVideo,
  assignTracksToAthlete,
  tracksForAthlete,
  analyzeProject,
  cancelJob,
  clipsFromMoments,
  createProject,
  createReel,
  distinctSpans,
  getAthlete,
  getFocalAthlete,
  getJob,
  loadTrackSeries,
  isReelEelError,
  listAthleteCandidates,
  proposeAthleteTracks,
  listAthletes,
  listExports,
  listJobLogsSince,
  listJobs,
  listRecentJobLogs,
  listVideos,
  loadConfig,
  nowIso,
  projectDir,
  removeAthlete,
  removeExport,
  removeJob,
  removeProject,
  removeVideo,
  renderReel,
  aiScript,
  templateScript,
  speak,
  voiceApiKey,
  listClips,
  listMoments,
  readManifest,
  createJob,
  logJob,
  updateJob,
  resolveProjectRoot,
  thumbnailPath,
  updateAthlete,
  updateMoment,
  updateProject,
  updateReel,
} from '@reeleel/core';
import type { AspectRatio, Preset } from '@reeleel/core';

import {
  appendChunk,
  cancelSession,
  createSession,
  demoteSession,
  discardSession,
  findSession,
  promoteSession,
  renameSession,
} from './chunked.js';
import { boundaryOf } from './multipart.js';
import { parseByteRange } from './range.js';
import { UploadError, receiveVideoUpload } from './receive.js';
import {
  beginUpload,
  failUpload,
  finishUpload,
  forgetUpload,
  getUploadFor,
  importingUpload,
  listUploads,
  reopenUpload,
} from './uploads.js';
import type { UploadRecord } from './uploads.js';

/**
 * Every mutation the UI can perform.
 *
 * These are plain form posts that redirect, not JSON endpoints: the pages are
 * server-rendered and must keep working without JavaScript. The JSON API in
 * @reeleel/api stays the machine-facing surface.
 */

const field = (body: Record<string, unknown>, name: string): string => {
  const value = body[name];
  return typeof value === 'string' ? value.trim() : '';
};

const optional = (body: Record<string, unknown>, name: string): string | undefined => {
  const value = field(body, name);
  return value.length > 0 ? value : undefined;
};

/** Carries a short message back to the redirected-to page. */
const back = (c: Context, to: string, message?: string, error?: string): Response => {
  const params = new URLSearchParams();
  if (message !== undefined) params.set('ok', message);
  if (error !== undefined) params.set('err', error);
  const query = params.toString();
  return c.redirect(query.length > 0 ? `${to}?${query}` : to);
};

const failed = (error: unknown): string =>
  isReelEelError(error) ? `${error.message}${error.hint === undefined ? '' : ` ${error.hint}`}` : String(error);

/**
 * A failure reduced to the parts every surface needs: a stable code to key off,
 * a sentence to show, a hint, and a status. Silence is not one of the options.
 */
interface Described {
  code: string;
  error: string;
  hint: string | undefined;
  status: ContentfulStatusCode;
}

const describe = (error: unknown): Described => {
  if (error instanceof UploadError) {
    return {
      code: error.code,
      error: error.message,
      hint: error.hint,
      status: error.status as ContentfulStatusCode,
    };
  }
  if (isReelEelError(error)) {
    return { code: error.code, error: error.message, hint: error.hint, status: 400 };
  }
  return {
    code: 'UNKNOWN',
    error: error instanceof Error ? error.message : String(error),
    hint: undefined,
    status: 500,
  };
};

/**
 * The client's view of an upload. Server paths stay on the server; `offset` is
 * named for what the client does with it — the byte to resume from.
 */
const view = (record: UploadRecord): Record<string, unknown> => ({
  id: record.id,
  projectRef: record.projectRef,
  fileName: record.fileName,
  status: record.status,
  offset: record.bytesReceived,
  bytesReceived: record.bytesReceived,
  bytesExpected: record.bytesExpected,
  percent:
    record.bytesExpected === null || record.bytesExpected === 0
      ? null
      : Math.min(1, record.bytesReceived / record.bytesExpected),
  code: record.code,
  error: record.error,
  hint: record.hint,
  videoId: record.videoId,
  startedAt: record.startedAt,
  updatedAt: record.updatedAt,
  finishedAt: record.finishedAt,
});

/** A JSON error for the upload API, recording the failure when given a record. */
const uploadJson = (c: Context, error: unknown, record?: UploadRecord | null): Response => {
  const described = describe(error);
  if (record !== undefined && record !== null) {
    failUpload(record, { ...described, cause: error });
  } else if (described.status >= 500) {
    process.stderr.write(`[upload -] ${described.code}: ${described.error}\n`);
  }
  return c.json(
    {
      ok: false,
      code: described.code,
      error: described.error,
      hint: described.hint,
      ...(record === undefined || record === null ? {} : { upload: view(record) }),
    },
    described.status,
  );
};

/**
 * The enhanced uploader asks for JSON so it can show a real error; the plain
 * form gets the redirect it has always got. Both carry the same upload id.
 */
const prefersJson = (c: Context): boolean =>
  (c.req.header('accept') ?? '').includes('application/json');

const uploadOk = (
  c: Context,
  to: string,
  message: string,
  record: UploadRecord | null,
): Response => {
  if (record !== null) c.header('x-upload-id', record.id);
  return prefersJson(c)
    ? c.json({ ok: true, message, uploadId: record?.id ?? null })
    : back(c, to, message);
};

const uploadFailed = (
  c: Context,
  to: string,
  record: UploadRecord | null,
  error: unknown,
): Response => {
  const described = describe(error);
  if (record !== null) {
    c.header('x-upload-id', record.id);
    failUpload(record, { ...described, hint: described.hint, cause: error });
  } else {
    process.stderr.write(`[upload -] failed ${described.code}: ${described.error}\n`);
  }
  if (prefersJson(c)) {
    return c.json(
      { ok: false, code: described.code, error: described.error, hint: described.hint, uploadId: record?.id ?? null },
      described.status,
    );
  }
  // The id goes in the flash so a user can quote it and an operator can grep it.
  const suffix = record === null ? '' : ` (upload ${record.id})`;
  const hint = described.hint === undefined ? '' : ` ${described.hint}`;
  return back(c, to, undefined, `${described.error}${hint}${suffix}`);
};

/**
 * Analyses running in this process, by job id.
 *
 * Cancelling has to reach the work, not just relabel the row: `cancelJob`
 * alone would mark a job canceled while FFmpeg and the detector carried on
 * chewing through the video. The signal is what makes Stop mean stop.
 */
const runningAnalyses = new Map<string, AbortController>();

/** Kicks off an analysis and keeps hold of its cancel handle. */
const startAnalysis = (
  root: string,
  options: { preset: Preset; videoId?: string; scoreOnly?: boolean },
): void => {
  const controller = new AbortController();
  let jobId: string | null = null;

  void analyzeProject(root, {
    preset: options.preset,
    ...(options.videoId === undefined ? {} : { videoId: options.videoId }),
    // Re-scoring reuses the detection that already ran: seconds, not minutes.
    ...(options.scoreOnly === true ? { scoreOnly: true } : {}),
    signal: controller.signal,
    onStart: (job) => {
      jobId = job.id;
      runningAnalyses.set(job.id, controller);
    },
  })
    .catch((error: unknown) => {
      process.stderr.write(`analysis failed: ${failed(error)}\n`);
    })
    .finally(() => {
      if (jobId !== null) runningAnalyses.delete(jobId);
    });
};

/**
 * Renders a reel as a *job*, so it appears where every other long task does.
 *
 * Rendering was fired off with `void renderReel(...).catch(write to stderr)`.
 * It worked — a 20-second reel landed on disk — and the person who asked for it
 * saw nothing at all until they happened to reload the page, so "I did export
 * reel and nothing" was a completely reasonable reading of a successful render.
 * A failure would have been even quieter: the reason went to the server's
 * stderr and nowhere else.
 */
const startRender = (
  root: string,
  name: string,
  aspect: AspectRatio,
  polish: {
    musicPath?: string;
    musicVolume?: number;
    fadeSeconds?: number;
    announcer?: boolean;
  } = {},
): void => {
  void (async () => {
    const job = await createJob(root, 'render', { name, aspect, ...polish });
    try {
      await updateJob(root, job.id, { status: 'running', stage: 'render', progress: 0.05 });
      await logJob(
        root,
        job.id,
        `rendering "${name}" at ${aspect}` +
          (polish.musicPath === undefined ? '' : ` with ${path.basename(polish.musicPath)} underneath`),
      );

      /**
       * Commentary, when asked for. Everything here degrades rather than
       * fails: no key means no announcer, a refused or failed script means
       * template lines, and a line that will not synthesise is skipped. A reel
       * must never fail to render because a third-party voice service is down.
       */
      const voiceOver: { path: string; startSeconds: number }[] = [];
      if (polish.announcer === true) {
        const voiceKey = voiceApiKey();
        if (voiceKey === null) {
          await logJob(
            root,
            job.id,
            'announcer: no ELEVENLABS_API_KEY configured, rendering without commentary',
            'warn',
          );
        } else {
          const [clips, moments, athletes, manifest] = await Promise.all([
            listClips(root),
            listMoments(root, { limit: 500 }),
            listAthletes(root),
            Promise.resolve(readManifest(root)),
          ]);
          const context = {
            athleteName: athletes.find((a) => a.isFocal)?.name ?? athletes[0]?.name ?? null,
            sport: manifest.sport,
            projectName: manifest.name,
          };

          const aiKey = process.env['ANTHROPIC_API_KEY'];
          const lines =
            aiKey === undefined || aiKey.length === 0
              ? templateScript(clips, moments, context)
              : await aiScript(clips, moments, context, {
                  apiKey: aiKey,
                  onProgress: (message) => void logJob(root, job.id, message, 'warn'),
                });

          const written = lines.filter((line) => line.fromTitle).length;
          await logJob(
            root,
            job.id,
            `announcer: ${lines.length} line(s), ${written} from titles you wrote`,
          );

          const voiceDir = projectDir(root, 'music');
          for (const line of lines) {
            try {
              const audio = await speak(line.text, voiceDir, { apiKey: voiceKey });
              voiceOver.push({ path: audio, startSeconds: line.startSeconds });
              await logJob(root, job.id, `announcer: “${line.text}”`);
            } catch (error) {
              await logJob(root, job.id, `announcer: ${failed(error)}`, 'warn');
            }
          }
        }
      }

      const { announcer: _announcer, ...renderPolish } = polish;
      const result = await renderReel(root, name, {
        aspect,
        ...renderPolish,
        ...(voiceOver.length > 0 ? { voiceOver } : {}),
        onProgress: (message) => {
          void logJob(root, job.id, message);
        },
      });

      await logJob(
        root,
        job.id,
        `done: ${path.basename(result.outputPath)} — ${result.clipCount} clip(s), ` +
          `${result.durationSeconds.toFixed(1)}s, ready under Exports`,
      );
      await updateJob(root, job.id, { status: 'completed', stage: 'done', progress: 1 });
    } catch (error) {
      // Said out loud, on the job, where the person who asked is looking.
      await logJob(root, job.id, `render failed: ${failed(error)}`, 'error');
      await updateJob(root, job.id, { status: 'failed', stage: 'render', error: failed(error) });
    }
  })();
};

export const registerActions = (app: Hono): void => {
  const guard = async (c: Context): Promise<Response | null> =>
    originAllowed(c) ? null : c.text('Bad origin', 403);

  const rootOf = async (c: Context): Promise<string> => {
    const ref = c.req.param('ref');
    if (ref === undefined) throw new Error('No project given.');
    return resolveProjectRoot(decodeURIComponent(ref), scopeFor(c));
  };

  // ── Projects ──────────────────────────────────────────────────────────────

  app.post('/projects', async (c) => {
    const bad = await guard(c);
    if (bad !== null) return bad;

    const body = await c.req.parseBody();
    const name = field(body, 'name');
    if (name.length === 0) return back(c, '/', undefined, 'A project needs a name.');

    try {
      const owner = ownerFor(c);
      const created = await createProject({
        name,
        sport: field(body, 'sport') || 'soccer',
        ...(optional(body, 'opponent') === undefined ? {} : { opponent: optional(body, 'opponent') as string }),
        ...(optional(body, 'gameDate') === undefined ? {} : { gameDate: optional(body, 'gameDate') as string }),
        ...(owner === undefined ? {} : { ownerId: owner }),
      });
      return c.redirect(`/projects/${encodeURIComponent(created.manifest.id)}?ok=Project+created`);
    } catch (error) {
      return back(c, '/', undefined, failed(error));
    }
  });

  app.post('/projects/:ref/update', async (c) => {
    const bad = await guard(c);
    if (bad !== null) return bad;
    const ref = c.req.param('ref') ?? '';

    try {
      const root = await rootOf(c);
      const body = await c.req.parseBody();
      // An empty field clears the value, matching the CLI's convention.
      await updateProject(root, {
        ...(field(body, 'name').length > 0 ? { name: field(body, 'name') } : {}),
        opponent: field(body, 'opponent').length > 0 ? field(body, 'opponent') : null,
        gameDate: field(body, 'gameDate').length > 0 ? field(body, 'gameDate') : null,
        description: field(body, 'description').length > 0 ? field(body, 'description') : null,
      });
      return back(c, `/projects/${encodeURIComponent(ref)}`, 'Saved');
    } catch (error) {
      return back(c, `/projects/${encodeURIComponent(ref)}`, undefined, failed(error));
    }
  });

  app.post('/projects/:ref/delete', async (c) => {
    const bad = await guard(c);
    if (bad !== null) return bad;

    try {
      const root = await rootOf(c);
      const body = await c.req.parseBody();
      // Deleting footage is irreversible, so the destructive variant needs an
      // explicit checkbox rather than being the default.
      await removeProject(root, { deleteFiles: field(body, 'deleteFiles') === 'on' });
      return back(c, '/', 'Project removed');
    } catch (error) {
      return back(c, '/', undefined, failed(error));
    }
  });

  // ── Videos ────────────────────────────────────────────────────────────────

  /**
   * Import footage — by upload, or by a path already on the server.
   *
   * The upload is streamed to disk rather than parsed into memory: see
   * receive.ts for why that distinction is the whole bug this route used to
   * have. Every attempt is tracked from before its first byte, so a failure at
   * any point has an id, a code and a log line instead of a dead progress bar.
   */
  app.post('/projects/:ref/videos', async (c) => {
    const bad = await guard(c);
    if (bad !== null) return bad;
    const ref = c.req.param('ref') ?? '';
    const to = `/projects/${encodeURIComponent(ref)}`;

    let record: UploadRecord | null = null;
    try {
      const root = await rootOf(c);

      // A plain (non-multipart) post can only be the server-path form; it has
      // no body worth streaming, so the simple path stays simple.
      if (boundaryOf(c.req.header('content-type')) === null) {
        const body = await c.req.parseBody();
        const filePath = field(body, 'path');
        if (filePath.length === 0) {
          return uploadFailed(c, to, null, new UploadError('NO_FILE', 'Choose a file or give a path.'));
        }
        await addVideo(root, filePath, { copy: field(body, 'copy') === 'on' });
        return uploadOk(c, to, 'Footage imported', null);
      }

      const declared = Number(c.req.header('content-length'));
      record = beginUpload({
        projectRef: ref,
        ownerId: ownerFor(c),
        bytesExpected: Number.isFinite(declared) && declared > 0 ? declared : null,
        // The browser names the upload up front so that if the connection dies
        // before any response, it still knows what to ask /uploads/:id about.
        id: c.req.header('x-upload-id'),
      });

      const received = await receiveVideoUpload(c, {
        root,
        record,
        exists: (target) => existsSync(target),
        // This is the no-JavaScript path, where the collision is found ~30 kB
        // into a body that may still have 200 MB to go. Rejecting there answers
        // a request the browser has not finished sending, and the browser
        // discards the response — the user gets a protocol error instead of the
        // reason. Taking a free name lets the import succeed instead.
        onCollision: 'rename',
      });

      if (received.savedPath !== null) {
        importingUpload(record);
        try {
          await addVideo(root, received.savedPath);
        } catch (error) {
          // The copy in source/ is ours alone; a rejected import must not leave
          // it behind to collide with the user's next attempt.
          await unlink(received.savedPath).catch(() => undefined);
          throw error;
        }
        finishUpload(record);
        // Say so when the name had to change, rather than leaving the user to
        // wonder why the file in the list is not the one they picked.
        const stored = received.file?.filename;
        const renamed = stored !== undefined && record.fileName !== null && record.fileName !== stored;
        return uploadOk(
          c,
          to,
          renamed ? `Footage imported as ${record.fileName} — that name was already taken` : 'Footage imported',
          record,
        );
      }

      // No file part — the user filled in the server-path field instead.
      const filePath = (received.fields['path'] ?? '').trim();
      if (filePath.length === 0) {
        return uploadFailed(c, to, record, new UploadError('NO_FILE', 'Choose a file or give a path.'));
      }
      await addVideo(root, filePath, { copy: received.fields['copy'] === 'on' });
      finishUpload(record);
      return uploadOk(c, to, 'Footage imported', record);
    } catch (error) {
      return uploadFailed(c, to, record, error);
    }
  });

  /**
   * The progress and outcome of one upload, by id alone. The uploader polls
   * this when a connection drops mid-post, which is the case where the browser
   * itself can tell the user nothing at all.
   */
  app.get('/uploads/:id', (c) => {
    const record = getUploadFor(c.req.param('id') ?? '', ownerFor(c));
    if (record === undefined) {
      return c.json({ ok: false, code: 'NOT_FOUND', error: 'No such upload.' }, 404);
    }
    return c.json({ ok: true, upload: view(record) });
  });

  // ── Identifying the athlete ───────────────────────────────────────────────
  //
  // A detector cannot know which of twenty children on a court is yours.
  // Somebody has to say so once. Until that happens `focal_track_id` is null,
  // and scoring — which reads the track, not the is_focal flag — is capped
  // below its own threshold no matter what detection found.

  /** Tracks worth offering as "that one is mine", longest-lived first. */
  app.get('/projects/:ref/candidates', async (c) => {
    try {
      const root = await rootOf(c);
      const videoId = c.req.query('videoId');
      const candidates = await listAthleteCandidates(root, {
        ...(videoId === undefined ? {} : { videoId }),
      });
      const athletes = await listAthletes(root);
      // What the user already picked, so the grid reopens with it selected.
      const focalAthlete = athletes.find((athlete) => athlete.isFocal) ?? athletes[0];
      const assignedTrackIds =
        focalAthlete === undefined ? [] : await tracksForAthlete(root, focalAthlete.id);
      return c.json({
        ok: true,
        candidates,
        assignedTrackIds,
        athletes: athletes.map((athlete) => ({
          id: athlete.id,
          name: athlete.name,
          jerseyNumber: athlete.jerseyNumber,
          // The shirt is what distinguishes #14 in white from #14 in black,
          // so the picker needs both, not just a name.
          team: athlete.team,
          jerseyColor: athlete.jerseyColor,
          isFocal: athlete.isFocal,
          focalTrackId: athlete.focalTrackId,
        })),
      });
    } catch (error) {
      return uploadJson(c, error);
    }
  });

  /** One thumbnail frame. Path comes from the video id, never from the client. */
  app.get('/projects/:ref/videos/:id/thumb/:n', async (c) => {
    try {
      const root = await rootOf(c);
      const videoId = c.req.param('id') ?? '';
      const index = Number(c.req.param('n'));
      if (!Number.isInteger(index) || index < 1 || index > 10_000) {
        return c.text('Bad frame index', 400);
      }
      // The id is checked against the project's own videos, so a crafted id
      // cannot walk out of the thumbnails directory.
      const known = (await listVideos(root)).some((video) => video.id === videoId);
      if (!known) return c.text('No such video', 404);

      const file = thumbnailPath(root, videoId, index);
      if (!existsSync(file)) return c.text('No such frame', 404);

      c.header('content-type', 'image/jpeg');
      // Thumbnails are regenerated wholesale, so a long cache is safe within a run.
      c.header('cache-control', 'private, max-age=300');
      return c.body(Readable.toWeb(createReadStream(file)) as ReadableStream);
    } catch {
      return c.text('Not available', 404);
    }
  });

  /**
   * Binds an athlete to a track, then re-scores.
   *
   * Re-scoring runs with scoreOnly, so it reuses the detection that already
   * happened — seconds rather than another full pass. Identifying your athlete
   * should not cost another minute of inference.
   */
  /**
   * The rest of the game, found by what the athlete looks like.
   *
   * Picking an athlete by hand only ever labels them where the user happened to
   * look, and re-identification can only confirm a binding where it already
   * exists — production had a child known for 31.7s of a 300s game. This
   * proposes the other tracks that match their shirt, with the score, and
   * assigns nothing: the grid shows them for confirmation. A wrong answer here
   * puts somebody else's child in the reel, so it is deliberately a suggestion.
   */
  app.get('/projects/:ref/athletes/:id/suggestions', async (c) => {
    try {
      const root = await rootOf(c);
      const videoId = c.req.query('videoId');
      const found = await proposeAthleteTracks(root, c.req.param('id') ?? '', {
        ...(videoId === undefined ? {} : { videoId }),
      });

      // Reuse the picker's preview geometry so a proposal renders as the same
      // crop the user is already choosing from.
      const previews = new Map(
        (await listAthleteCandidates(root, { limit: 10_000, minSeconds: 0 })).map(
          (candidate) => [candidate.trackId, candidate],
        ),
      );

      return c.json({
        ok: true,
        considered: found.considered,
        referenceTrackIds: found.referenceTrackIds,
        proposals: found.proposals.flatMap((proposal) => {
          const preview = previews.get(proposal.trackId);
          return preview === undefined
            ? []
            : [
                {
                  ...preview,
                  score: proposal.score,
                  gapSeconds: proposal.gapSeconds,
                  distancePx: proposal.distancePx,
                },
              ];
        }),
      });
    } catch (error) {
      return uploadJson(c, error);
    }
  });

  app.post('/projects/:ref/athletes/:id/track', async (c) => {
    const bad = await guard(c);
    if (bad !== null) return bad;
    const ref = c.req.param('ref') ?? '';
    const to = `/projects/${encodeURIComponent(ref)}`;

    try {
      const root = await rootOf(c);
      const body = c.req.header('content-type')?.includes('application/json') === true
        ? ((await c.req.json().catch(() => ({}))) as {
            trackId?: string;
            trackIds?: string[];
            name?: string;
            jerseyNumber?: string;
            team?: string;
            jerseyColor?: string;
            expand?: boolean;
          })
        : { trackId: field(await c.req.parseBody(), 'trackId') };

      /**
       * Who this is, if the picker asked.
       *
       * A number on its own does not identify a child: both teams have a 14 and
       * they are regularly on court together. The shirt colour is the part a
       * parent actually uses — "#14 in white" — and `jersey_color` has been on
       * the athlete row since the first migration without anything ever writing
       * it. Optional, because pointing at the right player remains the only
       * thing scoring genuinely needs.
       */
      const identity = {
        ...(typeof body.name === 'string' && body.name.trim().length > 0
          ? { name: body.name.trim() }
          : {}),
        ...(typeof body.jerseyNumber === 'string' && body.jerseyNumber.trim().length > 0
          ? { jerseyNumber: body.jerseyNumber.trim() }
          : {}),
        ...(typeof body.team === 'string' && body.team.trim().length > 0
          ? { team: body.team.trim() }
          : {}),
        ...(typeof body.jerseyColor === 'string' && body.jerseyColor.trim().length > 0
          ? { jerseyColor: body.jerseyColor.trim() }
          : {}),
      };

      /**
       * Several tracks, because the tracker splits one child into several.
       * A comma-separated list keeps the no-JS form working unchanged.
       */
      const requestedIds = (
        Array.isArray(body.trackIds)
          ? body.trackIds
          : String(body.trackId ?? '').split(',')
      )
        .map((id) => (typeof id === 'string' ? id.trim() : ''))
        .filter((id) => id.length > 0);

      const trackId = requestedIds[0] ?? '';
      if (trackId.length === 0) throw new UploadError('INVALID_INPUT', 'Choose a track first.');

      /**
       * `new` means "I have not told you who this is", not "make me another
       * one".
       *
       * It created an athlete unconditionally, and the client sends it whenever
       * its own athlete list has not loaded yet — which is every click made
       * faster than a page reload. A user marking their child on the footage,
       * pausing and clicking again a dozen times, produced a dozen athletes
       * named "My athlete", each bound to exactly one fragment, each in turn
       * made the focal one. Scoring reads the focal flag, so all of that work
       * collapsed to whichever click happened last: production ended up with
       * eight athletes, seven of them duplicates created less than three
       * minutes apart, and one selection in use.
       *
       * Identifying is still the one step that cannot be skipped, so this
       * still creates an athlete when there genuinely is none. It just prefers
       * the one already being followed.
       */
      const requested = c.req.param('id') ?? '';
      const existing = requested === 'new' ? await listAthletes(root) : [];
      const reusable = existing.find((candidate) => candidate.isFocal) ?? existing[0];
      const athlete =
        requested === 'new'
          ? (reusable ?? (await addAthlete(root, { name: 'My athlete', ...identity })))
          : await getAthlete(root, requested);
      const athleteId = athlete.id;
      // Following and being bound to a track are different things; a picked
      // athlete is obviously the one to follow. Any identity the picker
      // collected rides along, so "#14 in white" replaces "My athlete" — on a
      // reused athlete too, which is how a name reaches one created before the
      // fields existed.
      await updateAthlete(root, athleteId, { focalTrackId: trackId, focal: true, ...identity });

      /**
       * Add to the athlete, or set them, depending on what the caller knew.
       *
       * The picker holds the whole selection and posts all of it, so unticking
       * a crop has to be able to remove it — that call names the athlete and
       * replaces the set. A caller that said `new` did not know who this was
       * and cannot have sent the existing fragments, so replacing would silently
       * discard every earlier pick. Marking the same child at six moments on the
       * footage should leave them marked at six moments.
       */
      const adding = requested === 'new' && reusable !== undefined;
      const finalIds = adding
        ? [...new Set([...(await tracksForAthlete(root, athleteId)), ...requestedIds])]
        : requestedIds;
      const assigned = await assignTracksToAthlete(root, athleteId, finalIds);

      /**
       * Follow them through the rest of the game, if the caller cannot.
       *
       * Stitching one pick into the fragments either side of it has existed
       * since the appearance matcher landed, but the only way to reach it was
       * the candidate grid, which offers proposals to tick. The scrubber — the
       * surface people actually use, because pointing at your child on the
       * footage needs no explanation — bound the single track under the cursor
       * and stopped. Production shows exactly that: an athlete on 2 tracks out
       * of 1125, and one suggested moment, in a game they play the whole of.
       *
       * The proposals are the same ones the grid pre-ticks for confirmation, so
       * accepting them here is the behaviour that surface already had. It is
       * best-effort: a failure to expand must never lose the pick itself, which
       * is the part the user made and the part scoring cannot do without.
       */
      let added: string[] = [];
      if (body.expand === true) {
        try {
          const found = await proposeAthleteTracks(root, athleteId, {});
          added = found.proposals.map((proposal) => proposal.trackId);
          if (added.length > 0) {
            // The whole set, not the additions: assigning is a replace, and it
            // clears the athlete's existing rows before it writes.
            await assignTracksToAthlete(root, athleteId, [...new Set([...finalIds, ...added])]);
          }
        } catch {
          // No worker, no proxy, nothing to link to — all survivable. The pick
          // stands, and the grid can still be used to widen it by hand.
          added = [];
        }
      }

      startAnalysis(root, { preset: 'balanced', scoreOnly: true });

      if (prefersJson(c)) {
        return c.json({ ok: true, athleteId, trackId, assigned, added: added.length });
      }
      return back(c, to, 'Athlete identified — re-scoring with them as the focus');
    } catch (error) {
      if (prefersJson(c)) return uploadJson(c, error);
      return back(c, to, undefined, failed(error));
    }
  });

  // ── Job controls: stop, replay, discard ───────────────────────────────────
  //
  // The pipeline could already cancel and re-run; none of it was reachable from
  // the browser, so a run that went wrong could only be waited out.

  /** Stop. Aborts the actual work, then records the cancellation. */
  app.post('/projects/:ref/jobs/:id/cancel', async (c) => {
    const bad = await guard(c);
    if (bad !== null) return bad;
    const ref = c.req.param('ref') ?? '';
    const to = `/projects/${encodeURIComponent(ref)}`;

    try {
      const root = await rootOf(c);
      const id = c.req.param('id') ?? '';
      // Abort first: the job row is the record, the signal is the mechanism.
      runningAnalyses.get(id)?.abort();
      runningAnalyses.delete(id);
      await cancelJob(root, id);
      return back(c, to, 'Analysis canceled');
    } catch (error) {
      return back(c, to, undefined, failed(error));
    }
  });

  /**
   * Replay. Re-runs with the settings the original used, rather than whatever
   * the form happens to show now — the point of replaying a specific run.
   */
  app.post('/projects/:ref/jobs/:id/retry', async (c) => {
    const bad = await guard(c);
    if (bad !== null) return bad;
    const ref = c.req.param('ref') ?? '';
    const to = `/projects/${encodeURIComponent(ref)}`;

    try {
      const root = await rootOf(c);
      const job = await getJob(root, c.req.param('id') ?? '');
      if (job.status === 'running' || job.status === 'queued') {
        return back(c, to, undefined, 'That analysis is still running.');
      }

      const params = job.params as { preset?: string; videoIds?: unknown };
      const preset = (typeof params.preset === 'string' ? params.preset : 'balanced') as Preset;
      const videoIds = Array.isArray(params.videoIds) ? params.videoIds : [];
      // One video means it was a single-video run; several means "all", and
      // analyzeProject reads that as "no filter".
      const videoId = videoIds.length === 1 && typeof videoIds[0] === 'string' ? videoIds[0] : undefined;

      startAnalysis(root, { preset, ...(videoId === undefined ? {} : { videoId }) });
      return back(c, to, 'Analysis restarted — watch the live log');
    } catch (error) {
      return back(c, to, undefined, failed(error));
    }
  });

  /** Discard a finished run from the history. */
  app.post('/projects/:ref/jobs/:id/delete', async (c) => {
    const bad = await guard(c);
    if (bad !== null) return bad;
    const ref = c.req.param('ref') ?? '';
    const to = `/projects/${encodeURIComponent(ref)}`;

    try {
      const root = await rootOf(c);
      await removeJob(root, c.req.param('id') ?? '');
      return back(c, to, 'Removed from history');
    } catch (error) {
      return back(c, to, undefined, failed(error));
    }
  });

  /**
   * Downloads a rendered reel.
   *
   * Exports were written to the server's disk and never surfaced anywhere, so
   * "the file appears under exports when done" meant a path the user had no way
   * to reach. The record's own stored path is used, but only after checking it
   * still sits inside this project — the row is the authority on which export
   * this is, not on where the process may read from.
   */
  app.get('/projects/:ref/exports/:id/download', async (c) => {
    const ref = c.req.param('ref') ?? '';
    const to = `/projects/${encodeURIComponent(ref)}`;
    try {
      const root = await rootOf(c);
      const record = (await listExports(root)).find((entry) => entry.id === c.req.param('id'));
      if (record === undefined) return back(c, to, undefined, 'No such export.');

      const resolved = path.resolve(record.path);
      const within = path.resolve(projectDir(root, 'exports'));
      if (!resolved.startsWith(`${within}${path.sep}`)) {
        return back(c, to, undefined, 'That export is not inside this project.');
      }
      if (!existsSync(resolved)) {
        return back(c, to, undefined, 'That export is no longer on disk.');
      }

      const name = path.basename(resolved);
      c.header('content-type', 'video/mp4');
      c.header('content-length', String(statSync(resolved).size));
      c.header('content-disposition', `attachment; filename="${name}"`);
      // Streamed, for the same reason uploads are: a reel is not a thing to
      // hold in memory.
      return c.body(Readable.toWeb(createReadStream(resolved)) as ReadableStream);
    } catch (error) {
      return back(c, to, undefined, failed(error));
    }
  });

  /**
   * Streams a video so a suggested moment can be watched where it was
   * suggested.
   *
   * Judging a five-second suggestion used to mean keeping it, building clips,
   * exporting, and downloading a reel — a minutes-long round trip to answer
   * "is this any good?", which is a question you have to ask of every moment.
   *
   * Range requests are the whole point: without them a browser cannot seek, so
   * playing a moment three minutes in would mean downloading the three minutes
   * before it. The proxy is preferred over the source for the same reason —
   * 47MB rather than 198MB, and it is already on disk.
   */
  app.get('/projects/:ref/videos/:id/stream', async (c) => {
    try {
      const root = await rootOf(c);
      const video = (await listVideos(root)).find((entry) => entry.id === c.req.param('id'));
      if (video === undefined) return c.text('No such video', 404);

      const file =
        video.proxyPath !== null && video.proxyPath !== undefined && existsSync(video.proxyPath)
          ? video.proxyPath
          : video.path;
      if (!existsSync(file)) return c.text('That footage is no longer on disk', 404);

      const size = statSync(file).size;
      const range = c.req.header('range');
      c.header('accept-ranges', 'bytes');
      c.header('content-type', 'video/mp4');

      const parsedRange = parseByteRange(range, size);
      if (parsedRange.kind === 'none') {
        c.header('content-length', String(size));
        return c.body(Readable.toWeb(createReadStream(file)) as ReadableStream);
      }

      if (parsedRange.kind === 'invalid') {
        c.header('content-range', `bytes */${size}`);
        return c.body(null, 416);
      }

      const { start, end } = parsedRange;
      c.header('content-range', `bytes ${start}-${end}/${size}`);
      c.header('content-length', String(end - start + 1));
      return c.body(
        Readable.toWeb(createReadStream(file, { start, end })) as ReadableStream,
        206,
      );
    } catch (error) {
      return c.text(failed(error), 500);
    }
  });

  /**
   * What the detector saw, over one slice of time.
   *
   * "It hasn't really detected anybody" is unanswerable from a list of numbers.
   * Boxes drawn on the footage answer it in a second — and answer the harder
   * question too, which is whether the thing being followed is actually your
   * child. Sent as data for the browser to draw rather than burned into a
   * re-encoded video: no ffmpeg, no wait, and the focal athlete can be
   * distinguished from everyone else.
   */
  app.get('/projects/:ref/videos/:id/tracks', async (c) => {
    try {
      const root = await rootOf(c);
      const videoId = c.req.param('id') ?? '';
      const known = (await listVideos(root)).find((entry) => entry.id === videoId);
      if (known === undefined) return c.json({ ok: false, error: 'No such video' }, 404);

      const from = Number(c.req.query('from') ?? 0);
      const to = Number(c.req.query('to') ?? 0);
      if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) {
        return c.json({ ok: false, error: 'Bad time range' }, 400);
      }

      const focal = await getFocalAthlete(root);
      const focalIds = focal === null ? [] : await tracksForAthlete(root, focal.id);
      const focalSet = new Set([
        ...focalIds,
        ...(focal?.focalTrackId === null || focal?.focalTrackId === undefined
          ? []
          : [focal.focalTrackId]),
      ]);

      // Boxes are stored in source pixels; the player shows the proxy, so the
      // client is told the frame it should scale against.
      const series = await loadTrackSeries(root, videoId);
      const tracks = series
        .map((track) => ({
          id: track.id,
          className: track.className,
          focal: focalSet.has(track.id),
          samples: track.samples
            .filter((sample) => sample.ts >= from && sample.ts <= to)
            .map((sample) => ({
              ts: Number(sample.ts.toFixed(3)),
              x: Math.round(sample.x),
              y: Math.round(sample.y),
              w: Math.round(sample.w),
              h: Math.round(sample.h),
            })),
        }))
        .filter((track) => track.samples.length > 0);

      return c.json({
        ok: true,
        frameWidth: known.probe?.video?.width ?? 1920,
        frameHeight: known.probe?.video?.height ?? 1080,
        tracks,
      });
    } catch (error) {
      return uploadJson(c, error);
    }
  });

  /**
   * Uploads a music bed. Small files, so a plain form post is fine — this is
   * not the multi-hundred-megabyte path the video uploader exists for.
   */
  app.post('/projects/:ref/music', async (c) => {
    const bad = await guard(c);
    if (bad !== null) return bad;
    const ref = c.req.param('ref') ?? '';
    const to = `/projects/${encodeURIComponent(ref)}`;

    try {
      const root = await rootOf(c);
      const body = await c.req.parseBody();
      const file = body['music'];
      if (!(file instanceof File) || file.size === 0) {
        return back(c, to, undefined, 'Choose an audio file first.');
      }
      if (file.size > 50 * 1024 * 1024) {
        return back(c, to, undefined, 'That is over 50MB — a music bed should be far smaller.');
      }

      // The name is the client's; the directory is ours. basename keeps a
      // crafted "../../" out of the project.
      const safe = path.basename(file.name).replace(/[^\w.\- ]+/g, '_');
      if (!/\.(mp3|m4a|aac|wav|ogg|flac)$/i.test(safe)) {
        return back(c, to, undefined, 'That does not look like an audio file.');
      }

      const dir = projectDir(root, 'music');
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, safe), Buffer.from(await file.arrayBuffer()));
      return back(c, to, `${safe} added — pick it when you export`);
    } catch (error) {
      return back(c, to, undefined, failed(error));
    }
  });

  /**
   * Names a moment.
   *
   * The one thing in the system that knows what actually happened. Detection
   * knows a ball was near a player; only the person who was there knows it was
   * a steal. The announcer builds its line around this when it is present and
   * falls back to something deliberately plain when it is not.
   */
  app.post('/projects/:ref/moments/:id/title', async (c) => {
    const bad = await guard(c);
    if (bad !== null) return bad;
    const ref = c.req.param('ref') ?? '';
    const to = `/projects/${encodeURIComponent(ref)}`;

    try {
      const root = await rootOf(c);
      const title = field(await c.req.parseBody(), 'title').slice(0, 200);
      await updateMoment(root, c.req.param('id') ?? '', { title: title.length === 0 ? null : title });
      return back(c, to, title.length === 0 ? 'Title cleared' : `Saved “${title}”`);
    } catch (error) {
      return back(c, to, undefined, failed(error));
    }
  });

  /** Removes one export. Older versions are kept, so this has to be possible. */
  app.post('/projects/:ref/exports/:id/delete', async (c) => {
    const bad = await guard(c);
    if (bad !== null) return bad;
    const ref = c.req.param('ref') ?? '';
    const to = `/projects/${encodeURIComponent(ref)}`;
    try {
      const root = await rootOf(c);
      await removeExport(root, c.req.param('id') ?? '');
      return back(c, to, 'Export deleted');
    } catch (error) {
      return back(c, to, undefined, failed(error));
    }
  });

  /**
   * A live feed of job state and job logs, over Server-Sent Events.
   *
   * Analysis takes minutes and the page used to say "Refresh for progress",
   * which is the same class of non-answer as a progress bar that stops: the
   * work is happening, the stages and their failures are already recorded, and
   * none of it reaches the person waiting.
   *
   * The source of truth is the project database, so this polls it and pushes
   * on change rather than subscribing to an in-process emitter. That is
   * deliberate — a job started by the CLI, in a different process entirely,
   * shows up here exactly the same way.
   */
  app.get('/projects/:ref/jobs/stream', async (c) => {
    const root = await rootOf(c);

    // Resume where a dropped connection left off. EventSource replays its last
    // id automatically, so a reconnect does not repeat or skip lines.
    const resumeFrom = Number(c.req.header('last-event-id') ?? c.req.query('since') ?? Number.NaN);

    c.header('cache-control', 'no-cache, no-transform');
    // Without this, a buffering proxy holds the stream and "realtime" becomes
    // "all at once, at the end".
    c.header('x-accel-buffering', 'no');

    return streamSSE(c, async (stream) => {
      let cursor = Number.isFinite(resumeFrom) ? resumeFrom : -1;
      let previous = '';
      let idle = 0;
      let sinceKeepalive = 0;

      if (cursor < 0) {
        // A fresh feed opens with recent history, so the log is not blank
        // while waiting for the next thing to happen.
        const recent = await listRecentJobLogs(root, 100);
        cursor = recent.at(-1)?.id ?? 0;
        if (recent.length > 0) {
          await stream.writeSSE({ event: 'log', data: JSON.stringify(recent), id: String(cursor) });
        }
      }

      // Half a minute of silence with nothing running is enough; the client
      // reconnects on its own, and an idle stream should not pin a connection.
      const MAX_IDLE_TICKS = 50;
      const TICK_MS = 600;
      // ~9s between heartbeats: often enough to look alive, rare enough to be
      // free.
      const KEEPALIVE_TICKS = 15;

      while (!stream.closed && !stream.aborted) {
        const jobs = await listJobs(root, { limit: 10 });
        const serialized = JSON.stringify(jobs);
        let sent = false;
        if (serialized !== previous) {
          previous = serialized;
          idle = 0;
          sent = true;
          await stream.writeSSE({ event: 'jobs', data: serialized });
        }

        const lines = await listJobLogsSince(root, cursor, 500);
        if (lines.length > 0) {
          cursor = lines[lines.length - 1]?.id ?? cursor;
          idle = 0;
          sent = true;
          await stream.writeSSE({ event: 'log', data: JSON.stringify(lines), id: String(cursor) });
        }

        /**
         * A heartbeat, because "nothing has changed" and "this feed is dead"
         * look identical to a client otherwise — and a long detection pass can
         * genuinely produce no change for a while. It also keeps intermediate
         * proxies from closing a connection they think has gone idle.
         */
        sinceKeepalive = sent ? 0 : sinceKeepalive + 1;
        if (sinceKeepalive >= KEEPALIVE_TICKS) {
          sinceKeepalive = 0;
          await stream.writeSSE({ event: 'ping', data: JSON.stringify({ at: nowIso() }) });
        }

        const busy = jobs.some((job) => job.status === 'running' || job.status === 'queued');
        idle = busy ? 0 : idle + 1;
        if (idle > MAX_IDLE_TICKS) {
          // A comment frame, so the client sees a clean close rather than a
          // dead socket, and reconnects when it wants to.
          await stream.writeSSE({ event: 'idle', data: '{}' });
          return;
        }

        await stream.sleep(TICK_MS);
      }
    });
  });

  // ── Uploads: resumable, chunked, and fully CRUD-able ──────────────────────
  //
  // The one-shot form post above still works and always will. This is the
  // surface the browser uses: a file is created, its bytes are appended in
  // chunks at explicit offsets, and it is finished as a separate step. Because
  // the offset is durable, an upload that dies part-way resumes rather than
  // restarting — which is the whole point.

  /** List — every upload for a project, newest first. */
  app.get('/projects/:ref/uploads', async (c) => {
    const ref = c.req.param('ref') ?? '';
    try {
      await rootOf(c); // Authorises the project before revealing anything.
      return c.json({
        ok: true,
        uploads: listUploads({
          ownerId: ownerFor(c),
          projectRef: ref,
          includeFinished: c.req.query('active') !== 'true',
        }).map(view),
      });
    } catch (error) {
      return uploadJson(c, error);
    }
  });

  /** Create — reserve an upload and check everything cheap up front. */
  app.post('/projects/:ref/uploads', async (c) => {
    const bad = await guard(c);
    if (bad !== null) return bad;
    const ref = c.req.param('ref') ?? '';

    try {
      const root = await rootOf(c);
      const body = (await c.req.json().catch(() => ({}))) as {
        fileName?: string;
        size?: number;
        id?: string;
      };
      const record = await createSession({
        root,
        projectRef: ref,
        ownerId: ownerFor(c),
        fileName: typeof body.fileName === 'string' ? body.fileName : '',
        size: Number(body.size),
        ...(typeof body.id === 'string' ? { id: body.id } : {}),
        exists: (target) => existsSync(target),
      });
      c.header('x-upload-id', record.id);
      return c.json({ ok: true, upload: view(record) }, 201);
    } catch (error) {
      return uploadJson(c, error);
    }
  });

  /** Read — where did it get to, and did it fail? */
  app.get('/projects/:ref/uploads/:id', async (c) => {
    try {
      const root = await rootOf(c);
      const record = await findSession(root, c.req.param('id') ?? '', ownerFor(c));
      return c.json({ ok: true, upload: view(record) });
    } catch (error) {
      return uploadJson(c, error);
    }
  });

  /**
   * Append one chunk at `x-upload-offset`. Mismatched offsets are refused with
   * the offset to use, so a confused client corrects itself instead of quietly
   * corrupting the file.
   */
  app.put('/projects/:ref/uploads/:id/data', async (c) => {
    const bad = await guard(c);
    if (bad !== null) return bad;

    try {
      const root = await rootOf(c);
      const record = await findSession(root, c.req.param('id') ?? '', ownerFor(c));
      const offset = Number(c.req.header('x-upload-offset') ?? Number.NaN);
      if (!Number.isInteger(offset) || offset < 0) {
        throw new UploadError('INVALID_INPUT', 'A numeric x-upload-offset header is required.');
      }
      const body = c.req.raw.body;
      if (body === null) throw new UploadError('UPLOAD_INCOMPLETE', 'The chunk had no body.');

      // A retried chunk that already landed is a success, not a conflict.
      if (record.status === 'failed') reopenUpload(record);
      await appendChunk({ record, offset, body });
      return c.json({ ok: true, upload: view(record) });
    } catch (error) {
      return uploadJson(c, error);
    }
  });

  /**
   * Finish — promote the scratch file and import it. Separate from the last
   * chunk so the import can be retried without re-sending anything.
   */
  app.post('/projects/:ref/uploads/:id/finish', async (c) => {
    const bad = await guard(c);
    if (bad !== null) return bad;

    let record: UploadRecord | null = null;
    try {
      const root = await rootOf(c);
      record = await findSession(root, c.req.param('id') ?? '', ownerFor(c));
      if (record.status === 'done') return c.json({ ok: true, upload: view(record) });
      // Already running. A large file's import can outlast the connection that
      // asked for it, and the client's natural response is to ask again —
      // which, unguarded, would promote a part file that is no longer there and
      // report a missing upload for an import that is going fine.
      if (record.status === 'importing') return c.json({ ok: true, upload: view(record) }, 202);

      reopenUpload(record);
      const stored = await promoteSession(root, record);
      importingUpload(record);
      try {
        const video = await addVideo(root, stored);
        finishUpload(record, video.id);
      } catch (error) {
        // Put the bytes back in scratch: the upload is still good, only the
        // import failed, so a rename or a retry costs nothing.
        await demoteSession(record);
        throw error;
      }
      return c.json({ ok: true, upload: view(record) });
    } catch (error) {
      return uploadJson(c, error, record);
    }
  });

  /** Update — rename the destination. Fixes a collision without re-uploading. */
  app.patch('/projects/:ref/uploads/:id', async (c) => {
    const bad = await guard(c);
    if (bad !== null) return bad;

    try {
      const root = await rootOf(c);
      const record = await findSession(root, c.req.param('id') ?? '', ownerFor(c));
      const body = (await c.req.json().catch(() => ({}))) as { fileName?: string };
      if (typeof body.fileName !== 'string') {
        throw new UploadError('INVALID_INPUT', 'Give a fileName to change.');
      }
      await renameSession({ root, record, fileName: body.fileName, exists: (t) => existsSync(t) });
      if (record.status === 'failed') reopenUpload(record);
      return c.json({ ok: true, upload: view(record) });
    } catch (error) {
      return uploadJson(c, error);
    }
  });

  /**
   * Delete — cancel an upload in flight, or forget a finished one. Never
   * touches footage that has already been imported; that is what the video
   * delete route is for.
   */
  app.delete('/projects/:ref/uploads/:id', async (c) => {
    const bad = await guard(c);
    if (bad !== null) return bad;

    try {
      const root = await rootOf(c);
      const record = await findSession(root, c.req.param('id') ?? '', ownerFor(c));
      if (record.status === 'done') {
        await discardSession(root, record);
        forgetUpload(record.id);
        return c.json({ ok: true, deleted: record.id, keptVideo: record.videoId });
      }
      await cancelSession(root, record);
      forgetUpload(record.id);
      return c.json({ ok: true, deleted: record.id, keptVideo: null });
    } catch (error) {
      return uploadJson(c, error);
    }
  });

  app.post('/projects/:ref/videos/:id/delete', async (c) => {
    const bad = await guard(c);
    if (bad !== null) return bad;
    const ref = c.req.param('ref') ?? '';
    const to = `/projects/${encodeURIComponent(ref)}`;

    try {
      const root = await rootOf(c);
      await removeVideo(root, c.req.param('id') ?? '');
      return back(c, to, 'Video removed');
    } catch (error) {
      return back(c, to, undefined, failed(error));
    }
  });

  // ── Athletes ──────────────────────────────────────────────────────────────

  app.post('/projects/:ref/athletes', async (c) => {
    const bad = await guard(c);
    if (bad !== null) return bad;
    const ref = c.req.param('ref') ?? '';
    const to = `/projects/${encodeURIComponent(ref)}`;

    try {
      const root = await rootOf(c);
      const body = await c.req.parseBody();
      await addAthlete(root, {
        ...(optional(body, 'name') === undefined ? {} : { name: optional(body, 'name') as string }),
        ...(optional(body, 'number') === undefined ? {} : { jerseyNumber: optional(body, 'number') as string }),
        ...(optional(body, 'team') === undefined ? {} : { team: optional(body, 'team') as string }),
        ...(optional(body, 'color') === undefined ? {} : { jerseyColor: optional(body, 'color') as string }),
        ...(field(body, 'focal') === 'on' ? { focal: true } : {}),
      });
      return back(c, to, 'Athlete added');
    } catch (error) {
      return back(c, to, undefined, failed(error));
    }
  });

  app.post('/projects/:ref/athletes/:id/focus', async (c) => {
    const bad = await guard(c);
    if (bad !== null) return bad;
    const ref = c.req.param('ref') ?? '';
    const to = `/projects/${encodeURIComponent(ref)}`;

    try {
      const root = await rootOf(c);
      await updateAthlete(root, c.req.param('id') ?? '', { focal: true });
      return back(c, to, 'Now following this athlete');
    } catch (error) {
      return back(c, to, undefined, failed(error));
    }
  });

  app.post('/projects/:ref/athletes/:id/delete', async (c) => {
    const bad = await guard(c);
    if (bad !== null) return bad;
    const ref = c.req.param('ref') ?? '';
    const to = `/projects/${encodeURIComponent(ref)}`;

    try {
      const root = await rootOf(c);
      await removeAthlete(root, c.req.param('id') ?? '');
      return back(c, to, 'Athlete removed');
    } catch (error) {
      return back(c, to, undefined, failed(error));
    }
  });

  // ── Analysis and output ───────────────────────────────────────────────────

  app.post('/projects/:ref/analyze', async (c) => {
    const bad = await guard(c);
    if (bad !== null) return bad;
    const ref = c.req.param('ref') ?? '';
    const to = `/projects/${encodeURIComponent(ref)}`;

    try {
      const root = await rootOf(c);
      const body = await c.req.parseBody();
      const preset = (field(body, 'preset') || loadConfig().analysis.preset) as Preset;
      // "all" is the explicit opt-in; anything else names one video. Analysing
      // everything by default meant one unreadable file took the whole run with
      // it, and re-analysed footage that had already been done.
      const chosen = field(body, 'videoId');
      const videoId = chosen.length === 0 || chosen === 'all' ? undefined : chosen;

      // Analysis takes minutes; holding the request open would time out at the
      // proxy. It records a job, so the page can report progress instead.
      startAnalysis(root, { preset, ...(videoId === undefined ? {} : { videoId }) });

      return back(c, to, 'Analysis started — watch the live log');
    } catch (error) {
      return back(c, to, undefined, failed(error));
    }
  });

  app.post('/projects/:ref/moments/:id/decide', async (c) => {
    const bad = await guard(c);
    if (bad !== null) return bad;
    const ref = c.req.param('ref') ?? '';
    const to = `/projects/${encodeURIComponent(ref)}`;

    try {
      const root = await rootOf(c);
      const body = await c.req.parseBody();
      const decision = field(body, 'decision');
      await updateMoment(root, c.req.param('id') ?? '', {
        included: decision === 'keep' ? true : decision === 'reject' ? false : null,
      });
      return back(c, to);
    } catch (error) {
      return back(c, to, undefined, failed(error));
    }
  });

  app.post('/projects/:ref/clips', async (c) => {
    const bad = await guard(c);
    if (bad !== null) return bad;
    const ref = c.req.param('ref') ?? '';
    const to = `/projects/${encodeURIComponent(ref)}`;

    try {
      const root = await rootOf(c);
      const created = await clipsFromMoments(root);
      return back(c, to, `${created.length} clip(s) created`);
    } catch (error) {
      return back(c, to, undefined, failed(error));
    }
  });

  app.post('/projects/:ref/export', async (c) => {
    const bad = await guard(c);
    if (bad !== null) return bad;
    const ref = c.req.param('ref') ?? '';
    const to = `/projects/${encodeURIComponent(ref)}`;

    try {
      const root = await rootOf(c);
      const body = await c.req.parseBody();
      const name = field(body, 'name') || 'highlights';
      const aspect = (field(body, 'aspect') || '16:9') as AspectRatio;

      /**
       * Bring the reel up to date with the moments, then render in the
       * background for the same reason analysis runs detached.
       *
       * Both halves of this were missing, and together they made "export" a
       * button that re-rendered the past.
       *
       * `createReel` defaults its clip list to every clip that exists at the
       * moment it is called, and `reel_clips` is a fixed membership afterwards.
       * On the second export the create throws CONFLICT, the catch swallows it,
       * and the reel still holds the snapshot it took the first time. A
       * production reel was pinned to four clips chosen on its first render and
       * rendered those same four for the next five exports, across two days and
       * several detection runs — no new moment could ever reach it.
       *
       * The clips themselves were equally stale: accepting a moment does not
       * make a clip, so unless the user found the separate "create clips"
       * action, the newly suggested moments were not even candidates.
       * `clipsFromMoments` replaces generated clips and leaves manual ones
       * alone, so this is safe to run on every export and keeps anything the
       * user made by hand.
       */
      await clipsFromMoments(root);
      // Deduplicated, because pointing the reel at "every clip" is only an
      // improvement if the project's history cannot put the same five seconds
      // in it three times over — and this project's can.
      const clipIds = distinctSpans(await listClips(root)).map((clip) => clip.id);
      try {
        await createReel(root, { name, aspect, clipIds });
      } catch {
        // Already exists — refresh what it points at rather than reusing a
        // membership list frozen at whatever the project held that first day.
        await updateReel(root, name, { aspect, clipIds });
      }
      /**
       * Music is optional and remembered per project: it lives in the project
       * directory, so re-rendering does not mean re-uploading it.
       */
      const musicDir = projectDir(root, 'music');
      const chosen = field(body, 'music');
      const musicPath =
        chosen.length === 0 || chosen === 'none'
          ? undefined
          : path.join(musicDir, path.basename(chosen));
      if (musicPath !== undefined && !existsSync(musicPath)) {
        return back(c, to, undefined, 'That music file is no longer there.');
      }

      const volume = Number(field(body, 'musicVolume'));
      const fade = Number(field(body, 'fadeSeconds'));

      startRender(root, name, aspect, {
        ...(field(body, 'announcer') === '1' ? { announcer: true } : {}),
        ...(musicPath === undefined ? {} : { musicPath }),
        ...(Number.isFinite(volume) && volume >= 0 && volume <= 1 ? { musicVolume: volume } : {}),
        ...(Number.isFinite(fade) && fade >= 0 && fade <= 3 ? { fadeSeconds: fade } : {}),
      });

      return back(c, to, 'Rendering — progress appears in the job log, then under Exports');
    } catch (error) {
      return back(c, to, undefined, failed(error));
    }
  });
};
