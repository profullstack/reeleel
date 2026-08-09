import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { modelStorePath } from '@reeleel/core';

/**
 * The default detector.
 *
 * YOLOX is Apache-2.0 — framework *and* released weights — which is why it is
 * the default rather than a YOLOv8 checkpoint. Ultralytics' weights are
 * AGPL-3.0, and the PRD is explicit that a FOSS framework does not make its
 * weights redistributable. Nothing is bundled; this is fetched on demand and
 * recorded in the model registry with its license.
 *
 * It is a general COCO model, so it finds people and a ball. It does not know
 * what a referee or a goal is — see classes.ts.
 */
export const DEFAULT_MODEL = {
  name: 'yolox-tiny',
  version: '0.1.1rc0',
  license: 'Apache-2.0',
  architecture: 'YOLOX-Tiny',
  runtime: 'onnx',
  inputSize: 416,
  url: 'https://github.com/Megvii-BaseDetection/YOLOX/releases/download/0.1.1rc0/yolox_tiny.onnx',
} as const;

export const defaultModelPath = (sport: string): string =>
  path.join(modelStorePath(), sport, `${DEFAULT_MODEL.name}-${DEFAULT_MODEL.version}.onnx`);

export interface ResolveOptions {
  explicit?: string | undefined;
  sport: string;
}

/**
 * Where to find weights, in order of how deliberate the choice was:
 * an explicit flag, then the environment, then the model store.
 */
export const resolveModelPath = (options: ResolveOptions): string | null => {
  const candidates = [
    options.explicit,
    process.env['REELEEL_CV_MODEL'],
    defaultModelPath(options.sport),
  ];

  for (const candidate of candidates) {
    if (candidate === undefined || candidate.length === 0) continue;
    const resolved = path.resolve(candidate);
    if (existsSync(resolved) && statSync(resolved).isFile()) return resolved;
  }
  return null;
};

export const sha256 = (file: string): string =>
  createHash('sha256').update(readFileSync(file)).digest('hex');

export interface FetchResult {
  path: string;
  bytes: number;
  checksum: string;
  url: string;
}

export const fetchModel = async (
  url: string,
  destination: string,
  onProgress?: (received: number, total: number | null) => void,
): Promise<FetchResult> => {
  mkdirSync(path.dirname(destination), { recursive: true });

  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok || response.body === null) {
    throw new Error(`Download failed (${response.status}) for ${url}`);
  }

  const declared = response.headers.get('content-length');
  const total = declared === null ? null : Number(declared);
  let received = 0;

  const source = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
  source.on('data', (chunk: Buffer) => {
    received += chunk.length;
    onProgress?.(received, total);
  });

  // Write to a temporary name first, so an interrupted download never leaves
  // a truncated file that looks like a valid model.
  const partial = `${destination}.partial`;
  await pipeline(source, createWriteStream(partial));

  const { renameSync } = await import('node:fs');
  renameSync(partial, destination);

  return {
    path: destination,
    bytes: statSync(destination).size,
    checksum: sha256(destination),
    url,
  };
};
