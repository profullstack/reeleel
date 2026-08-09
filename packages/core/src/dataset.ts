import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { all, projectDb, toNumber } from './db.js';
import { ReelEelError, invalidInput } from './errors.js';
import { newId, nowIso } from './ids.js';
import { readManifest } from './projects.js';
import type { DatasetFormat } from './types.js';
import { listVideos } from './videos.js';

import { getSport, requiredClasses } from '@reeleel/sports';

export interface AnnotationRecord {
  id: string;
  videoId: string;
  trackId: string | null;
  frame: number;
  ts: number;
  className: string;
  x: number;
  y: number;
  w: number;
  h: number;
  occluded: boolean;
  outOfFrame: boolean;
}

export type DatasetSplit = 'train' | 'val' | 'test';

export interface SplitRatios {
  train: number;
  val: number;
  test: number;
}

export const DEFAULT_SPLIT: SplitRatios = { train: 0.7, val: 0.2, test: 0.1 };

/**
 * Splits by *video*, never by frame. Adjacent frames are near-duplicates, so a
 * frame-level split leaks the validation set into training and makes every
 * metric a lie. Deterministic: the same video id always lands in the same split
 * for a given seed, so re-exporting a dataset is reproducible.
 */
export const assignSplit = (videoId: string, ratios: SplitRatios, seed = 'reeleel'): DatasetSplit => {
  const total = ratios.train + ratios.val + ratios.test;
  if (total <= 0) throw invalidInput('Split ratios must sum to more than zero.');

  const digest = createHash('sha256').update(`${seed}:${videoId}`).digest();
  // Top 32 bits as a uniform value in [0,1).
  const value = digest.readUInt32BE(0) / 0x1_0000_0000;
  const trainCut = ratios.train / total;
  const valCut = trainCut + ratios.val / total;
  if (value < trainCut) return 'train';
  if (value < valCut) return 'val';
  return 'test';
};

interface AnnotationRow {
  id: string;
  video_id: string;
  track_id: string | null;
  frame: number;
  ts: number;
  class: string;
  x: number;
  y: number;
  w: number;
  h: number;
  occluded: number;
  out_of_frame: number;
}

export const listAnnotations = async (
  root: string,
  videoId?: string,
): Promise<AnnotationRecord[]> => {
  const db = await projectDb(root);
  const where = videoId === undefined ? '' : 'WHERE video_id = ?';
  const params = videoId === undefined ? [] : [videoId];
  const rows = await all<AnnotationRow>(
    db,
    `SELECT id, video_id, track_id, frame, ts, class, x, y, w, h, occluded, out_of_frame
     FROM annotations ${where} ORDER BY video_id, frame, id`,
    params,
  );

  return rows.map((row) => ({
    id: row.id,
    videoId: row.video_id,
    trackId: row.track_id,
    frame: toNumber(row.frame),
    ts: toNumber(row.ts),
    className: row.class,
    x: toNumber(row.x),
    y: toNumber(row.y),
    w: toNumber(row.w),
    h: toNumber(row.h),
    occluded: toNumber(row.occluded) === 1,
    outOfFrame: toNumber(row.out_of_frame) === 1,
  }));
};

export interface FrameImage {
  /** Stable 1-based id, assigned in (videoId, frame) order. */
  id: number;
  fileName: string;
  width: number;
  height: number;
  videoId: string;
  frame: number;
  split: DatasetSplit;
}

export interface DatasetBundle {
  name: string;
  createdAt: string;
  classes: string[];
  images: FrameImage[];
  annotations: AnnotationRecord[];
  splits: Record<DatasetSplit, number>;
}

const frameFileName = (videoId: string, frame: number): string =>
  `${videoId}_${String(frame).padStart(8, '0')}.jpg`;

export interface BuildDatasetOptions {
  ratios?: SplitRatios;
  seed?: string;
  /** Restrict to specific videos. */
  videoIds?: string[];
  /** Drop boxes flagged out-of-frame — they carry no visual evidence. */
  includeOutOfFrame?: boolean;
}

export const buildDataset = async (
  root: string,
  options: BuildDatasetOptions = {},
): Promise<DatasetBundle> => {
  const manifest = readManifest(root);
  const plugin = getSport(manifest.sport);
  if (plugin === null) {
    throw new ReelEelError('SPORT_UNKNOWN', `Project sport "${manifest.sport}" is not installed.`);
  }

  const ratios = options.ratios ?? DEFAULT_SPLIT;
  const seed = options.seed ?? manifest.id;
  const videos = (await listVideos(root)).filter(
    (video) => options.videoIds === undefined || options.videoIds.includes(video.id),
  );
  const videoById = new Map(videos.map((video) => [video.id, video]));

  const annotations = (await listAnnotations(root))
    .filter((annotation) => videoById.has(annotation.videoId))
    .filter((annotation) => options.includeOutOfFrame === true || !annotation.outOfFrame);

  const frames = new Map<string, { videoId: string; frame: number }>();
  for (const annotation of annotations) {
    frames.set(`${annotation.videoId}:${annotation.frame}`, {
      videoId: annotation.videoId,
      frame: annotation.frame,
    });
  }

  const sortedFrames = [...frames.values()].sort(
    (a, b) => a.videoId.localeCompare(b.videoId) || a.frame - b.frame,
  );

  const splits: Record<DatasetSplit, number> = { train: 0, val: 0, test: 0 };
  const images: FrameImage[] = sortedFrames.map((entry, index) => {
    const video = videoById.get(entry.videoId);
    const split = assignSplit(entry.videoId, ratios, seed);
    splits[split] += 1;
    return {
      id: index + 1,
      fileName: frameFileName(entry.videoId, entry.frame),
      width: video?.probe?.video?.width ?? 0,
      height: video?.probe?.video?.height ?? 0,
      videoId: entry.videoId,
      frame: entry.frame,
      split,
    };
  });

  return {
    name: `${manifest.name} (${manifest.id})`,
    createdAt: nowIso(),
    classes: requiredClasses(plugin),
    images,
    annotations,
    splits,
  };
};

/** COCO detection JSON. Field order is fixed so exports diff cleanly. */
export const toCoco = (bundle: DatasetBundle): unknown => {
  const imageIdByKey = new Map(bundle.images.map((image) => [`${image.videoId}:${image.frame}`, image.id]));
  const categoryIdByName = new Map(bundle.classes.map((name, index) => [name, index + 1]));

  return {
    info: {
      description: bundle.name,
      version: '1.0',
      date_created: bundle.createdAt,
      contributor: 'ReelEel',
    },
    licenses: [],
    categories: bundle.classes.map((name, index) => ({
      id: index + 1,
      name,
      supercategory: 'sport',
    })),
    images: bundle.images.map((image) => ({
      id: image.id,
      file_name: image.fileName,
      width: image.width,
      height: image.height,
      reeleel_video_id: image.videoId,
      reeleel_frame: image.frame,
      reeleel_split: image.split,
    })),
    annotations: bundle.annotations
      .map((annotation, index) => {
        const imageId = imageIdByKey.get(`${annotation.videoId}:${annotation.frame}`);
        const categoryId = categoryIdByName.get(annotation.className);
        if (imageId === undefined || categoryId === undefined) return null;
        return {
          id: index + 1,
          image_id: imageId,
          category_id: categoryId,
          bbox: [annotation.x, annotation.y, annotation.w, annotation.h],
          area: annotation.w * annotation.h,
          iscrowd: 0,
          reeleel_track_id: annotation.trackId,
          reeleel_occluded: annotation.occluded ? 1 : 0,
        };
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null),
  };
};

/** One label file per image: `class cx cy w h`, all normalized 0..1. */
export const toYolo = (bundle: DatasetBundle): Map<string, string> => {
  const classIndex = new Map(bundle.classes.map((name, index) => [name, index]));
  const imageByKey = new Map(bundle.images.map((image) => [`${image.videoId}:${image.frame}`, image]));
  const files = new Map<string, string[]>();

  for (const annotation of bundle.annotations) {
    const key = `${annotation.videoId}:${annotation.frame}`;
    const image = imageByKey.get(key);
    const index = classIndex.get(annotation.className);
    if (image === undefined || index === undefined) continue;
    if (image.width <= 0 || image.height <= 0) continue;

    const cx = (annotation.x + annotation.w / 2) / image.width;
    const cy = (annotation.y + annotation.h / 2) / image.height;
    const w = annotation.w / image.width;
    const h = annotation.h / image.height;

    const line = [index, cx, cy, w, h]
      .map((value, position) => (position === 0 ? String(value) : value.toFixed(6)))
      .join(' ');

    const fileName = `${image.split}/${image.fileName.replace(/\.jpg$/, '.txt')}`;
    const lines = files.get(fileName) ?? [];
    lines.push(line);
    files.set(fileName, lines);
  }

  return new Map([...files].map(([file, lines]) => [file, `${lines.join('\n')}\n`]));
};

export interface ExportResult {
  format: DatasetFormat;
  outputDir: string;
  files: string[];
  imageCount: number;
  annotationCount: number;
  splits: Record<DatasetSplit, number>;
}

export const exportDataset = async (
  root: string,
  format: DatasetFormat,
  outputDir: string,
  options: BuildDatasetOptions = {},
): Promise<ExportResult> => {
  const bundle = await buildDataset(root, options);
  const target = path.resolve(outputDir);
  mkdirSync(target, { recursive: true });
  const written: string[] = [];

  const write = (relative: string, contents: string): void => {
    const file = path.join(target, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, contents, 'utf8');
    written.push(file);
  };

  switch (format) {
    case 'coco': {
      write('annotations.json', `${JSON.stringify(toCoco(bundle), null, 2)}\n`);
      break;
    }
    case 'yolo': {
      for (const [file, contents] of toYolo(bundle)) write(path.join('labels', file), contents);
      write('classes.txt', `${bundle.classes.join('\n')}\n`);
      write(
        'data.yaml',
        [
          `path: ${target}`,
          'train: images/train',
          'val: images/val',
          'test: images/test',
          `nc: ${bundle.classes.length}`,
          `names: [${bundle.classes.map((name) => `'${name}'`).join(', ')}]`,
          '',
        ].join('\n'),
      );
      break;
    }
    case 'reeleel': {
      write('dataset.json', `${JSON.stringify(bundle, null, 2)}\n`);
      break;
    }
  }

  return {
    format,
    outputDir: target,
    files: written,
    imageCount: bundle.images.length,
    annotationCount: bundle.annotations.length,
    splits: bundle.splits,
  };
};

export interface ImportResult {
  imported: number;
  skipped: number;
  format: DatasetFormat;
}

interface CocoImage {
  id: number;
  file_name?: string;
  reeleel_video_id?: string;
  reeleel_frame?: number;
}

interface CocoAnnotation {
  image_id: number;
  category_id: number;
  bbox?: number[];
  reeleel_track_id?: string | null;
  reeleel_occluded?: number;
}

interface CocoFile {
  images?: CocoImage[];
  annotations?: CocoAnnotation[];
  categories?: { id: number; name: string }[];
}

/**
 * Parses a filename back into (videoId, frame). Export writes
 * `<videoId>_<frame>.ext`, and video ids never contain an underscore.
 */
export const parseFrameFileName = (fileName: string): { videoId: string; frame: number } | null => {
  const base = path.basename(fileName).replace(/\.[^.]+$/, '');
  const separator = base.lastIndexOf('_');
  if (separator <= 0) return null;
  const videoId = base.slice(0, separator);
  const frame = Number(base.slice(separator + 1));
  if (!Number.isInteger(frame)) return null;
  return { videoId, frame };
};

const insertAnnotations = async (
  root: string,
  records: Omit<AnnotationRecord, 'id'>[],
): Promise<number> => {
  const manifest = readManifest(root);
  const knownVideos = new Set((await listVideos(root)).map((video) => video.id));
  const db = await projectDb(root);
  const timestamp = nowIso();

  const sql = `INSERT INTO annotations
      (id, project_id, video_id, track_id, frame, ts, class, x, y, w, h,
       occluded, out_of_frame, keyframe, author, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'import', ?, ?)`;

  // One transaction so a malformed file halfway through leaves nothing behind.
  const tx = await db.transaction('write');
  let count = 0;
  try {
    for (const record of records) {
      if (!knownVideos.has(record.videoId)) continue;
      await tx.execute({
        sql,
        args: [
          newId('ann'),
          manifest.id,
          record.videoId,
          record.trackId,
          record.frame,
          record.ts,
          record.className,
          record.x,
          record.y,
          record.w,
          record.h,
          record.occluded ? 1 : 0,
          record.outOfFrame ? 1 : 0,
          timestamp,
          timestamp,
        ],
      });
      count += 1;
    }
    await tx.commit();
  } catch (error) {
    await tx.rollback();
    throw error;
  }
  return count;
};

export const importDataset = async (
  root: string,
  format: DatasetFormat,
  inputPath: string,
): Promise<ImportResult> => {
  const resolved = path.resolve(inputPath);
  const records: Omit<AnnotationRecord, 'id'>[] = [];
  let skipped = 0;

  if (format === 'coco' || format === 'reeleel') {
    const parsed = JSON.parse(readFileSync(resolved, 'utf8')) as CocoFile & Partial<DatasetBundle>;

    if (format === 'reeleel' && Array.isArray(parsed.annotations) && parsed.images !== undefined) {
      const native = parsed as DatasetBundle;
      for (const annotation of native.annotations) {
        records.push({ ...annotation });
      }
    } else {
      const categoryName = new Map((parsed.categories ?? []).map((c) => [c.id, c.name]));
      const imageById = new Map((parsed.images ?? []).map((image) => [image.id, image]));

      for (const annotation of parsed.annotations ?? []) {
        const image = imageById.get(annotation.image_id);
        const className = categoryName.get(annotation.category_id);
        const bbox = annotation.bbox;
        if (image === undefined || className === undefined || bbox === undefined || bbox.length < 4) {
          skipped += 1;
          continue;
        }
        const identity =
          image.reeleel_video_id !== undefined && image.reeleel_frame !== undefined
            ? { videoId: image.reeleel_video_id, frame: image.reeleel_frame }
            : parseFrameFileName(image.file_name ?? '');
        if (identity === null) {
          skipped += 1;
          continue;
        }
        records.push({
          videoId: identity.videoId,
          trackId: annotation.reeleel_track_id ?? null,
          frame: identity.frame,
          ts: 0,
          className,
          x: bbox[0] ?? 0,
          y: bbox[1] ?? 0,
          w: bbox[2] ?? 0,
          h: bbox[3] ?? 0,
          occluded: annotation.reeleel_occluded === 1,
          outOfFrame: false,
        });
      }
    }
  } else {
    // YOLO: a directory of label files plus classes.txt, normalized coordinates.
    const classesFile = path.join(resolved, 'classes.txt');
    const classes = readFileSync(classesFile, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    const videos = new Map((await listVideos(root)).map((video) => [video.id, video]));
    const labelRoot = path.join(resolved, 'labels');
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) return walk(full);
        return entry.name.endsWith('.txt') ? [full] : [];
      });

    for (const file of walk(labelRoot)) {
      const identity = parseFrameFileName(file);
      if (identity === null) {
        skipped += 1;
        continue;
      }
      const video = videos.get(identity.videoId);
      const width = video?.probe?.video?.width ?? 0;
      const height = video?.probe?.video?.height ?? 0;
      if (width <= 0 || height <= 0) {
        skipped += 1;
        continue;
      }

      for (const line of readFileSync(file, 'utf8').split('\n')) {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 5) continue;
        const classIndex = Number(parts[0]);
        const className = classes[classIndex];
        const cx = Number(parts[1]) * width;
        const cy = Number(parts[2]) * height;
        const w = Number(parts[3]) * width;
        const h = Number(parts[4]) * height;
        if (className === undefined || [cx, cy, w, h].some((n) => !Number.isFinite(n))) {
          skipped += 1;
          continue;
        }
        records.push({
          videoId: identity.videoId,
          trackId: null,
          frame: identity.frame,
          ts: 0,
          className,
          x: cx - w / 2,
          y: cy - h / 2,
          w,
          h,
          occluded: false,
          outOfFrame: false,
        });
      }
    }
  }

  return { imported: await insertAnnotations(root, records), skipped, format };
};
