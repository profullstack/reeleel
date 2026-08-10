import { all, changes, execute, get, parseJson, projectDb, toNumber } from './db.js';
import { ReelEelError, notFound } from './errors.js';
import { newId, nowIso } from './ids.js';
import { readManifest } from './projects.js';
import type { Job, JobKind, JobStatus } from './types.js';

interface JobRow {
  id: string;
  project_id: string;
  kind: JobKind;
  status: JobStatus;
  stage: string | null;
  progress: number;
  eta_seconds: number | null;
  error: string | null;
  params_json: string;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

const toJob = (row: JobRow): Job => ({
  id: row.id,
  projectId: row.project_id,
  kind: row.kind,
  status: row.status,
  stage: row.stage,
  progress: toNumber(row.progress),
  etaSeconds: row.eta_seconds === null ? null : toNumber(row.eta_seconds),
  error: row.error,
  params: parseJson<Record<string, unknown>>(row.params_json, {}),
  createdAt: row.created_at,
  startedAt: row.started_at,
  finishedAt: row.finished_at,
});

export const createJob = async (
  root: string,
  kind: JobKind,
  params: Record<string, unknown> = {},
): Promise<Job> => {
  const manifest = readManifest(root);
  const db = await projectDb(root);
  const id = newId('job');

  await execute(
    db,
    `INSERT INTO jobs (id, project_id, kind, status, progress, params_json, created_at)
     VALUES (?, ?, ?, 'queued', 0, ?, ?)`,
    [id, manifest.id, kind, JSON.stringify(params), nowIso()],
  );

  const row = await get<JobRow>(db, 'SELECT * FROM jobs WHERE id = ?', [id]);
  if (row === undefined) throw notFound('Job', id);
  return toJob(row);
};

export interface JobProgress {
  status?: JobStatus;
  stage?: string;
  progress?: number;
  etaSeconds?: number | null;
  error?: string | null;
}

export const updateJob = async (
  root: string,
  jobId: string,
  patch: JobProgress,
): Promise<Job> => {
  const db = await projectDb(root);
  const existing = await get<JobRow>(db, 'SELECT * FROM jobs WHERE id = ?', [jobId]);
  if (existing === undefined) throw notFound('Job', jobId);

  const status = patch.status ?? existing.status;
  const startedAt = existing.started_at ?? (status === 'running' ? nowIso() : null);
  const finishedAt =
    existing.finished_at ??
    (['completed', 'failed', 'canceled'].includes(status) ? nowIso() : null);

  await execute(
    db,
    `UPDATE jobs
       SET status = ?, stage = ?, progress = ?, eta_seconds = ?, error = ?,
           started_at = ?, finished_at = ?
     WHERE id = ?`,
    [
      status,
      patch.stage ?? existing.stage,
      patch.progress ?? toNumber(existing.progress),
      patch.etaSeconds === undefined ? existing.eta_seconds : patch.etaSeconds,
      patch.error === undefined ? existing.error : patch.error,
      startedAt,
      finishedAt,
      jobId,
    ],
  );

  const row = await get<JobRow>(db, 'SELECT * FROM jobs WHERE id = ?', [jobId]);
  if (row === undefined) throw notFound('Job', jobId);
  return toJob(row);
};

export const logJob = async (
  root: string,
  jobId: string,
  message: string,
  level: 'info' | 'warn' | 'error' = 'info',
): Promise<void> => {
  const db = await projectDb(root);
  await execute(db, 'INSERT INTO job_logs (job_id, at, level, message) VALUES (?, ?, ?, ?)', [
    jobId,
    nowIso(),
    level,
    message,
  ]);
};

export interface JobLogEntry {
  at: string;
  level: string;
  message: string;
}

export const getJobLogs = async (
  root: string,
  jobId: string,
  limit = 200,
): Promise<JobLogEntry[]> => {
  const db = await projectDb(root);
  const rows = await all<JobLogEntry>(
    db,
    'SELECT at, level, message FROM job_logs WHERE job_id = ? ORDER BY id DESC LIMIT ?',
    [jobId, limit],
  );
  return rows.reverse();
};

/** A log line with its rowid, which is what makes an incremental feed possible. */
export interface JobLogLine extends JobLogEntry {
  id: number;
  jobId: string;
}

interface JobLogRow {
  id: number;
  job_id: string;
  at: string;
  level: string;
  message: string;
}

const toLogLine = (row: JobLogRow): JobLogLine => ({
  id: toNumber(row.id),
  jobId: row.job_id,
  at: row.at,
  level: row.level,
  message: row.message,
});

/**
 * Everything logged after `afterId`, across every job in the project.
 *
 * The cursor is the point: a live feed has to be able to say "what happened
 * since I last looked" without re-sending the whole history or missing a line
 * that landed between polls.
 */
export const listJobLogsSince = async (
  root: string,
  afterId: number,
  limit = 500,
): Promise<JobLogLine[]> => {
  const db = await projectDb(root);
  const rows = await all<JobLogRow>(
    db,
    'SELECT id, job_id, at, level, message FROM job_logs WHERE id > ? ORDER BY id ASC LIMIT ?',
    [afterId, limit],
  );
  return rows.map(toLogLine);
};

/** The tail of the log, for giving a newly-opened feed some context. */
export const listRecentJobLogs = async (root: string, limit = 100): Promise<JobLogLine[]> => {
  const db = await projectDb(root);
  const rows = await all<JobLogRow>(
    db,
    'SELECT id, job_id, at, level, message FROM job_logs ORDER BY id DESC LIMIT ?',
    [limit],
  );
  return rows.reverse().map(toLogLine);
};

export interface ListJobsOptions {
  status?: JobStatus;
  kind?: JobKind;
  limit?: number;
}

export const listJobs = async (root: string, options: ListJobsOptions = {}): Promise<Job[]> => {
  const db = await projectDb(root);
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  if (options.status !== undefined) {
    clauses.push('status = ?');
    params.push(options.status);
  }
  if (options.kind !== undefined) {
    clauses.push('kind = ?');
    params.push(options.kind);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  params.push(options.limit ?? 50);

  const rows = await all<JobRow>(
    db,
    `SELECT * FROM jobs ${where} ORDER BY created_at DESC LIMIT ?`,
    params,
  );
  return rows.map(toJob);
};

export const getJob = async (root: string, jobId: string): Promise<Job> => {
  const db = await projectDb(root);
  const row = await get<JobRow>(db, 'SELECT * FROM jobs WHERE id = ?', [jobId]);
  if (row === undefined) throw notFound('Job', jobId);
  return toJob(row);
};

export const cancelJob = async (root: string, jobId: string): Promise<Job> => {
  const job = await getJob(root, jobId);
  if (['completed', 'failed', 'canceled'].includes(job.status)) {
    throw new ReelEelError('CONFLICT', `Job ${jobId} already ${job.status}; nothing to cancel.`);
  }
  return updateJob(root, jobId, { status: 'canceled', error: 'Canceled by user.' });
};

/** Re-queues a failed or canceled job with its original parameters. */
export const retryJob = async (root: string, jobId: string): Promise<Job> => {
  const job = await getJob(root, jobId);
  if (!['failed', 'canceled'].includes(job.status)) {
    throw new ReelEelError(
      'CONFLICT',
      `Job ${jobId} is ${job.status}; only failed or canceled jobs can be retried.`,
    );
  }
  return createJob(root, job.kind, job.params);
};

export const removeJob = async (root: string, jobId: string): Promise<Job> => {
  const job = await getJob(root, jobId);
  if (job.status === 'running') {
    throw new ReelEelError('CONFLICT', `Job ${jobId} is still running.`, {
      hint: `Cancel it first: reeleel jobs cancel ${jobId}`,
    });
  }
  const db = await projectDb(root);
  await execute(db, 'DELETE FROM jobs WHERE id = ?', [job.id]);
  return job;
};

/**
 * Fails any job left mid-flight by a restart.
 *
 * Analysis runs inside the web process, so a deploy — or a crash, or an OOM —
 * takes the work with it and leaves the row saying `running` forever. Nothing
 * was ever going to continue it, and nothing said so: the panel showed a live
 * job whose progress had quietly stopped advancing, which is indistinguishable
 * from a slow one. A ten-minute detection pass killed at frame 7350 of 9000
 * looked exactly like a ten-minute detection pass still going.
 *
 * Called on startup, when by definition this process owns no running work.
 */
export const failInterruptedJobs = async (root: string): Promise<number> => {
  const db = await projectDb(root);
  const orphans = await all<{ id: string }>(
    db,
    "SELECT id FROM jobs WHERE status IN ('running', 'queued')",
  );
  if (orphans.length === 0) return 0;

  for (const orphan of orphans) {
    await logJob(
      root,
      orphan.id,
      'interrupted: the server restarted while this was running. Nothing continues it — start it again.',
      'error',
    );
  }
  // `finished_at`, not `updated_at`: this table records when work stopped.
  await execute(
    db,
    `UPDATE jobs SET status = 'failed', error = ?, finished_at = ?
      WHERE status IN ('running', 'queued')`,
    ['Interrupted by a server restart.', nowIso()],
  );
  return orphans.length;
};

/** Bulk cleanup for `reeleel jobs prune`. */
export const pruneJobs = async (root: string, statuses: JobStatus[]): Promise<number> => {
  if (statuses.length === 0) return 0;
  const db = await projectDb(root);
  const placeholders = statuses.map(() => '?').join(', ');
  const result = await execute(db, `DELETE FROM jobs WHERE status IN (${placeholders})`, statuses);
  return changes(result);
};
