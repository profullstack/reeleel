/** @jsxImportSource hono/jsx/dom */
import { render, useState } from 'hono/jsx/dom';

/**
 * The moment list, made interactive.
 *
 * This lives in its own module rather than in the client entry point because
 * two callers need it: the entry mounts it on load, and live.ts re-mounts it
 * after swapping the region it sits in. That region is swapped precisely when a
 * job finishes — the moment new suggestions appear — and re-mounting pointed at
 * the wrong island, so the freshly rendered list arrived as inert server markup
 * with no Keep or Reject behind its buttons.
 */

export interface Moment {
  id: string;
  start: number;
  end: number;
  score: number;
  reasons: string[];
  included: boolean | null;
  favorite: boolean;
}

const duration = (seconds: number): string => {
  const total = Math.max(0, Math.round(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
};

const decision = (included: boolean | null): string =>
  included === true ? 'keep' : included === false ? 'reject' : 'undecided';

const MomentReview = ({ projectId, initial }: { projectId: string; initial: Moment[] }) => {
  const [moments, setMoments] = useState<Moment[]>(initial);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const decide = async (moment: Moment, included: boolean | null): Promise<void> => {
    setBusy(moment.id);
    setError(null);
    try {
      const response = await fetch(
        `/api/projects/${encodeURIComponent(projectId)}/moments/${moment.id}`,
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ included }),
        },
      );
      const payload = (await response.json()) as { ok: boolean; moment?: Moment; error?: string };
      if (!response.ok || !payload.ok || payload.moment === undefined) {
        throw new Error(payload.error ?? `Request failed (${response.status})`);
      }
      const updated = payload.moment;
      setMoments((current) => current.map((m) => (m.id === updated.id ? updated : m)));
    } catch (cause) {
      // Leave the previous state alone so the user can retry without losing work.
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const kept = moments.filter((m) => m.included === true).length;

  return (
    <div>
      <p class="muted">
        {kept} of {moments.length} kept
      </p>
      {error === null ? null : <p class="pill reject">{error}</p>}
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
              {decision(moment.included)}
            </span>
            <button
              type="button"
              disabled={busy === moment.id}
              onClick={() => void decide(moment, moment.included === true ? null : true)}
            >
              Keep
            </button>
            <button
              type="button"
              disabled={busy === moment.id}
              onClick={() => void decide(moment, moment.included === false ? null : false)}
            >
              Reject
            </button>
          </div>
        </div>
      ))}
    </div>
  );
};

/**
 * Takes over the server-rendered moment list, reading everything it needs from
 * the node's own attributes — which is what makes it safe to call again after
 * the server has re-rendered that region with different moments in it.
 */
export const mountMoments = (): void => {
  const node = document.getElementById('moment-review');
  if (node === null) return;

  const projectId = node.dataset['project'];
  const raw = node.dataset['moments'];
  if (projectId === undefined || raw === undefined) return;

  let initial: Moment[];
  try {
    initial = JSON.parse(raw) as Moment[];
  } catch {
    // Bad payload: keep the server-rendered list rather than blanking the page.
    return;
  }

  node.innerHTML = '';
  render(<MomentReview projectId={projectId} initial={initial} />, node);
};
