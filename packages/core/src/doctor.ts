import { statfsSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';

import { loadConfig } from './config.js';
import { findBinary, run } from './ffmpeg.js';
import { dataHome } from './layout.js';
import { listModels } from './models.js';
import { resolveCvWorker } from './analyze.js';

export type CheckStatus = 'ok' | 'warn' | 'fail';

export interface Check {
  name: string;
  status: CheckStatus;
  detail: string;
  hint?: string;
}

const versionOf = async (binary: string): Promise<string> => {
  try {
    const result = await run(binary, ['-version']);
    return result.stdout.split('\n')[0]?.trim() ?? 'unknown version';
  } catch {
    return 'unknown version';
  }
};

const gigabytes = (bytes: number): string => `${(bytes / 1024 ** 3).toFixed(1)} GB`;

/**
 * Everything `reeleel doctor` reports. Deliberately exhaustive about the things
 * the PRD says must fail gracefully, so a user can see *why* analysis will not
 * start before they wait on a long job.
 */
export const runChecks = async (): Promise<Check[]> => {
  const checks: Check[] = [];

  const [major] = process.versions.node.split('.').map(Number);
  checks.push({
    name: 'Node.js',
    status: (major ?? 0) >= 22 ? 'ok' : 'fail',
    detail: `v${process.versions.node}`,
    ...((major ?? 0) >= 22 ? {} : { hint: 'ReelEel needs Node 22.5 or newer for built-in SQLite.' }),
  });

  for (const binary of ['ffmpeg', 'ffprobe'] as const) {
    const found = findBinary(binary);
    if (found === null) {
      checks.push({
        name: binary,
        status: 'fail',
        detail: 'not found',
        hint: `Install FFmpeg, or run \`reeleel config set ffmpeg.${binary} /path/to/${binary}\`.`,
      });
    } else {
      checks.push({ name: binary, status: 'ok', detail: `${found} — ${await versionOf(found)}` });
    }
  }

  const worker = resolveCvWorker();
  checks.push(
    worker === null
      ? {
          name: 'CV worker',
          status: 'warn',
          detail: 'not installed',
          hint: 'Detection and tracking are unavailable. Import, review, trim and export still work.',
        }
      : { name: 'CV worker', status: 'ok', detail: `${worker.command} (${worker.kind})` },
  );

  const config = loadConfig();
  checks.push({
    name: 'Analysis backend',
    status: 'ok',
    detail:
      config.analysis.backend === 'auto'
        ? `auto (CPU always available, ${cpus().length} cores)`
        : config.analysis.backend,
  });

  checks.push({
    name: 'Memory',
    status: totalmem() >= 8 * 1024 ** 3 ? 'ok' : 'warn',
    detail: gigabytes(totalmem()),
    ...(totalmem() >= 8 * 1024 ** 3
      ? {}
      : { hint: 'Under 8 GB, prefer the `fast` preset and keep other apps closed.' }),
  });

  try {
    const stats = statfsSync(dataHome());
    const free = stats.bavail * stats.bsize;
    // A full game's proxy, thumbnails and clips run to a few GB.
    checks.push({
      name: 'Disk space',
      status: free > 10 * 1024 ** 3 ? 'ok' : free > 2 * 1024 ** 3 ? 'warn' : 'fail',
      detail: `${gigabytes(free)} free at ${dataHome()}`,
      ...(free > 10 * 1024 ** 3
        ? {}
        : { hint: 'A full game analysis typically needs several GB for proxies and clips.' }),
    });
  } catch {
    checks.push({ name: 'Disk space', status: 'warn', detail: 'could not be determined' });
  }

  const models = await listModels();
  checks.push(
    models.length === 0
      ? {
          name: 'Models',
          status: 'warn',
          detail: 'none registered',
          hint: 'Register one with `reeleel models add <name> --version <v> --file <weights>`.',
        }
      : { name: 'Models', status: 'ok', detail: `${models.length} registered` },
  );

  const unlicensed = models.filter((model) => model.license === 'unknown');
  if (unlicensed.length > 0) {
    checks.push({
      name: 'Model licenses',
      status: 'warn',
      detail: `${unlicensed.length} model(s) have no recorded license`,
      hint: 'A FOSS framework does not make its weights redistributable. Record each license.',
    });
  }

  return checks;
};

export const worstStatus = (checks: Check[]): CheckStatus => {
  if (checks.some((check) => check.status === 'fail')) return 'fail';
  if (checks.some((check) => check.status === 'warn')) return 'warn';
  return 'ok';
};
