/** @jsxImportSource hono/jsx/dom */
import { render, useEffect, useRef, useState } from 'hono/jsx/dom';

/**
 * The live analysis log.
 *
 * Analysis takes minutes and used to end at "Refresh for progress" — which,
 * when a stage failed, meant a table row saying `failed` and nothing else. The
 * stages and their errors were always recorded; they simply never reached the
 * person waiting on them.
 *
 * This subscribes to the job feed over SSE and renders both halves: what each
 * job is doing right now, and the running log of how it got there, including
 * the reason when something breaks.
 */

interface Job {
  id: string;
  kind: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'canceled';
  stage: string | null;
  progress: number;
  etaSeconds: number | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

interface LogLine {
  id: number;
  jobId: string;
  at: string;
  level: string;
  message: string;
}

type Connection = 'connecting' | 'live' | 'idle' | 'offline';

/** Keeps the log bounded; a long analysis can produce a lot of lines. */
const MAX_LINES = 1000;

const clock = (seconds: number | null): string => {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return '';
  const total = Math.round(seconds);
  if (total < 60) return `${total}s left`;
  const minutes = Math.floor(total / 60);
  return `${minutes}m ${String(total % 60).padStart(2, '0')}s left`;
};

const time = (iso: string): string => {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? '' : at.toLocaleTimeString();
};

const elapsed = (job: Job): string => {
  if (job.startedAt === null) return '';
  const end = job.finishedAt === null ? Date.now() : new Date(job.finishedAt).getTime();
  const seconds = (end - new Date(job.startedAt).getTime()) / 1000;
  if (!Number.isFinite(seconds) || seconds < 0) return '';
  return seconds < 60
    ? `${Math.round(seconds)}s`
    : `${Math.floor(seconds / 60)}m ${String(Math.round(seconds % 60)).padStart(2, '0')}s`;
};

const JobLog = ({ base }: { base: string }) => {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [lines, setLines] = useState<LogLine[]>([]);
  const [connection, setConnection] = useState<Connection>('connecting');
  const pane = useRef<HTMLDivElement | null>(null);
  /** Only pin to the bottom while the user is already there. */
  const pinned = useRef(true);
  const reloadWhenDone = useRef(false);

  useEffect(() => {
    let source: EventSource | null = null;
    let retry: number | undefined;
    let stopped = false;

    const connect = (): void => {
      if (stopped) return;
      source = new EventSource(`${base}/jobs/stream`);

      source.addEventListener('open', () => setConnection('live'));

      source.addEventListener('jobs', (event) => {
        const next = JSON.parse((event as MessageEvent<string>).data) as Job[];
        setJobs(next);
        if (next.some((job) => job.status === 'running' || job.status === 'queued')) {
          reloadWhenDone.current = true;
        } else if (reloadWhenDone.current && next.some((job) => job.status === 'completed')) {
          // Analysis writes moments; the page around this island is stale now.
          reloadWhenDone.current = false;
          window.setTimeout(() => window.location.reload(), 1500);
        }
      });

      source.addEventListener('log', (event) => {
        const batch = JSON.parse((event as MessageEvent<string>).data) as LogLine[];
        setLines((current) => {
          const seen = new Set(current.map((line) => line.id));
          const merged = [...current, ...batch.filter((line) => !seen.has(line.id))];
          return merged.length > MAX_LINES ? merged.slice(merged.length - MAX_LINES) : merged;
        });
      });

      // The server closes a quiet stream rather than holding a connection open
      // forever; that is not an error, so do not thrash reconnecting.
      source.addEventListener('idle', () => {
        setConnection('idle');
        source?.close();
        retry = window.setTimeout(connect, 15_000);
      });

      source.addEventListener('error', () => {
        setConnection('offline');
        source?.close();
        retry = window.setTimeout(connect, 3000);
      });
    };

    connect();
    return () => {
      stopped = true;
      if (retry !== undefined) window.clearTimeout(retry);
      source?.close();
    };
  }, [base]);

  useEffect(() => {
    if (pinned.current && pane.current !== null) {
      pane.current.scrollTop = pane.current.scrollHeight;
    }
  }, [lines]);

  const onScroll = (): void => {
    const node = pane.current;
    if (node === null) return;
    pinned.current = node.scrollHeight - node.scrollTop - node.clientHeight < 40;
  };

  const running = jobs.filter((job) => job.status === 'running' || job.status === 'queued');
  const recent = jobs.slice(0, 5);

  return (
    <div>
      {/* The page already has the "Analysis" heading; this only adds the state
          of the feed itself, so the user can tell a quiet job from a dead
          connection. */}
      <div class="row job-head">
        <span class="grow" />
        <span class={`pill live-${connection}`}>
          {connection === 'live'
            ? running.length > 0
              ? 'live'
              : 'connected'
            : connection === 'idle'
              ? 'idle'
              : connection === 'offline'
                ? 'reconnecting…'
                : 'connecting…'}
        </span>
      </div>

      {recent.length === 0 ? (
        <p class="muted">No analysis has run yet.</p>
      ) : (
        recent.map((job) => (
          <div class="card job-card" key={job.id}>
            <div class="row">
              <strong class="grow">
                {job.kind}
                {job.stage === null ? '' : ` — ${job.stage}`}
              </strong>
              <span class="muted">{elapsed(job)}</span>
              <span
                class={`pill ${job.status === 'completed' ? 'keep' : job.status === 'failed' || job.status === 'canceled' ? 'reject' : ''}`}
              >
                {job.status}
              </span>
            </div>

            {job.status === 'running' || job.status === 'queued' ? (
              <progress max={1} value={job.progress} />
            ) : null}

            <div class="row upload-meta">
              <span class="muted grow">
                {Math.round(job.progress * 100)}%
                {clock(job.etaSeconds) === '' ? '' : ` — ${clock(job.etaSeconds)}`}
              </span>
            </div>

            {/* The bit that was missing entirely: why it failed. */}
            {job.error === null ? null : <p class="pill reject upload-error">{job.error}</p>}
          </div>
        ))
      )}

      <div class="log-pane" ref={pane} onScroll={onScroll} role="log" aria-live="polite">
        {lines.length === 0 ? (
          <p class="muted">Waiting for the first stage…</p>
        ) : (
          lines.map((line) => (
            <div class={`log-line log-${line.level}`} key={line.id}>
              <span class="log-time">{time(line.at)}</span>
              <span class="log-message">{line.message}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
};

export const mountJobLog = (): void => {
  const node = document.getElementById('job-log');
  if (node === null) return;
  const base = node.dataset['base'];
  if (base === undefined) return;
  // Without EventSource the server-rendered table is still correct.
  if (typeof EventSource === 'undefined') return;

  node.innerHTML = '';
  render(<JobLog base={base} />, node);
};
