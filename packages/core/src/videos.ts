import { copyFileSync, existsSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';

import { loadConfig } from './config.js';
import { all, execute, get, parseJson, projectDb, toNumber } from './db.js';
import { ReelEelError, invalidInput, notFound } from './errors.js';
import { probe } from './ffmpeg.js';
import { newId, nowIso } from './ids.js';
import { projectDir } from './layout.js';
import { readManifest } from './projects.js';
import type { ProbeResult, SourceVideo } from './types.js';

/** Containers the PRD commits to for MVP import. */
export const SUPPORTED_EXTENSIONS = ['.mp4', '.mov', '.mkv', '.webm', '.m4v'] as const;

export const isSupportedExtension = (file: string): boolean =>
  (SUPPORTED_EXTENSIONS as readonly string[]).includes(path.extname(file).toLowerCase());

interface VideoRow {
  id: string;
  project_id: string;
  path: string;
  copied: number;
  sort_order: number;
  probe_json: string | null;
  proxy_path: string | null;
  thumbnail_dir: string | null;
  created_at: string;
  updated_at: string;
}

const toVideo = (row: VideoRow): SourceVideo => ({
  id: row.id,
  projectId: row.project_id,
  path: row.path,
  copied: toNumber(row.copied) === 1,
  order: toNumber(row.sort_order),
  probe: parseJson<ProbeResult | null>(row.probe_json, null),
  proxyPath: row.proxy_path,
  thumbnailDir: row.thumbnail_dir,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export interface AddVideoOptions {
  /** Copy into `source/` instead of referencing in place. */
  copy?: boolean;
  order?: number;
}

export const addVideo = async (
  root: string,
  file: string,
  options: AddVideoOptions = {},
): Promise<SourceVideo> => {
  const source = path.resolve(file);
  if (!existsSync(source)) {
    throw new ReelEelError('SOURCE_MISSING', `${source} does not exist.`);
  }
  if (!statSync(source).isFile()) {
    throw invalidInput(`${source} is not a file.`);
  }
  if (!isSupportedExtension(source)) {
    throw new ReelEelError(
      'MEDIA_UNSUPPORTED',
      `${path.extname(source)} is not a supported container.`,
      { hint: `Supported: ${SUPPORTED_EXTENSIONS.join(', ')}` },
    );
  }

  const manifest = readManifest(root);
  // Probe before writing anything, so a corrupt file never leaves a half row.
  const probed = await probe(source);

  const shouldCopy = options.copy ?? loadConfig().projects.copySource;
  let stored = source;
  if (shouldCopy) {
    stored = path.join(projectDir(root, 'source'), path.basename(source));
    if (existsSync(stored)) {
      throw new ReelEelError('CONFLICT', `${stored} already exists in this project.`);
    }
    copyFileSync(source, stored);
  }

  const db = await projectDb(root);
  const existing = await get<{ id: string }>(db, 'SELECT id FROM source_videos WHERE path = ?', [
    stored,
  ]);
  if (existing !== undefined) {
    throw new ReelEelError('CONFLICT', `${stored} is already in this project.`);
  }

  const maxRow = await get<{ n: number }>(
    db,
    'SELECT COALESCE(MAX(sort_order), -1) AS n FROM source_videos',
  );
  const order = options.order ?? toNumber(maxRow?.n ?? -1) + 1;
  const timestamp = nowIso();
  const id = newId('vid');

  await execute(
    db,
    `INSERT INTO source_videos
       (id, project_id, path, copied, sort_order, probe_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      manifest.id,
      stored,
      shouldCopy ? 1 : 0,
      order,
      JSON.stringify({ ...probed, path: stored }),
      timestamp,
      timestamp,
    ],
  );

  const row = await get<VideoRow>(db, 'SELECT * FROM source_videos WHERE id = ?', [id]);
  if (row === undefined) throw notFound('Video', id);
  return toVideo(row);
};

export const listVideos = async (root: string): Promise<SourceVideo[]> => {
  const db = await projectDb(root);
  const rows = await all<VideoRow>(
    db,
    'SELECT * FROM source_videos ORDER BY sort_order, created_at',
  );
  return rows.map(toVideo);
};

/** Accepts an id, a 1-based index, or a filename fragment. */
export const getVideo = async (root: string, reference: string): Promise<SourceVideo> => {
  const videos = await listVideos(root);
  const byId = videos.find((video) => video.id === reference);
  if (byId !== undefined) return byId;

  const index = Number(reference);
  if (Number.isInteger(index) && index >= 1 && index <= videos.length) {
    const found = videos[index - 1];
    if (found !== undefined) return found;
  }

  const matches = videos.filter((video) =>
    path.basename(video.path).toLowerCase().includes(reference.toLowerCase()),
  );
  const first = matches[0];
  if (matches.length === 1 && first !== undefined) return first;
  if (matches.length > 1) {
    throw new ReelEelError('CONFLICT', `"${reference}" matches ${matches.length} videos.`, {
      hint: `Use an id: ${matches.map((m) => m.id).join(', ')}`,
    });
  }
  throw notFound('Video', reference);
};

export interface VideoUpdate {
  order?: number;
  /** Re-point at a moved source file — the PRD's "source file moved" case. */
  path?: string;
  proxyPath?: string | null;
  thumbnailDir?: string | null;
  /** Re-run ffprobe and refresh cached media info. */
  reprobe?: boolean;
}

export const updateVideo = async (
  root: string,
  reference: string,
  patch: VideoUpdate,
): Promise<SourceVideo> => {
  const video = await getVideo(root, reference);

  let nextPath = video.path;
  if (patch.path !== undefined) {
    nextPath = path.resolve(patch.path);
    if (!existsSync(nextPath)) {
      throw new ReelEelError('SOURCE_MISSING', `${nextPath} does not exist.`);
    }
    if (!isSupportedExtension(nextPath)) {
      throw new ReelEelError('MEDIA_UNSUPPORTED', `${path.extname(nextPath)} is not supported.`);
    }
  }

  const shouldReprobe = patch.reprobe === true || patch.path !== undefined;
  const probed = shouldReprobe ? await probe(nextPath) : video.probe;

  const db = await projectDb(root);
  await execute(
    db,
    `UPDATE source_videos
       SET path = ?, sort_order = ?, probe_json = ?, proxy_path = ?, thumbnail_dir = ?, updated_at = ?
     WHERE id = ?`,
    [
      nextPath,
      patch.order ?? video.order,
      probed === null ? null : JSON.stringify({ ...probed, path: nextPath }),
      patch.proxyPath === undefined ? video.proxyPath : patch.proxyPath,
      patch.thumbnailDir === undefined ? video.thumbnailDir : patch.thumbnailDir,
      nowIso(),
      video.id,
    ],
  );

  const row = await get<VideoRow>(db, 'SELECT * FROM source_videos WHERE id = ?', [video.id]);
  if (row === undefined) throw notFound('Video', video.id);
  return toVideo(row);
};

export interface RemoveVideoOptions {
  /** Also delete the media file — only honoured for copied-in sources. */
  deleteFile?: boolean;
}

export const removeVideo = async (
  root: string,
  reference: string,
  options: RemoveVideoOptions = {},
): Promise<SourceVideo> => {
  const video = await getVideo(root, reference);

  if (options.deleteFile === true && !video.copied) {
    throw new ReelEelError(
      'UNSUPPORTED_OPERATION',
      'That video is referenced in place, not stored in the project.',
      { hint: 'ReelEel will not delete media it did not copy. Remove it yourself if you meant to.' },
    );
  }

  const db = await projectDb(root);
  // Detections, tracks and clips cascade via foreign keys.
  await execute(db, 'DELETE FROM source_videos WHERE id = ?', [video.id]);

  if (options.deleteFile === true && existsSync(video.path)) {
    rmSync(video.path, { force: true });
  }
  if (video.proxyPath !== null && existsSync(video.proxyPath)) {
    rmSync(video.proxyPath, { force: true });
  }
  if (video.thumbnailDir !== null && existsSync(video.thumbnailDir)) {
    rmSync(video.thumbnailDir, { recursive: true, force: true });
  }

  return video;
};

/** Videos whose source file has disappeared since import. */
export const findMissingSources = async (root: string): Promise<SourceVideo[]> => {
  const videos = await listVideos(root);
  return videos.filter((video) => !existsSync(video.path));
};
