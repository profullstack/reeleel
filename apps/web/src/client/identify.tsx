/** @jsxImportSource hono/jsx/dom */
import { render, useEffect, useState } from 'hono/jsx/dom';

/**
 * "Which one is yours?"
 *
 * The detector finds every person on the court. It cannot know which of them
 * you came here for, and until somebody says, scoring has no focal track —
 * three of its seven signals stay dark and no clip can pass the threshold. This
 * is the one irreducibly manual step in the product, so it should cost one
 * click and not require reading a track id.
 *
 * Each candidate is shown as the frame it appears in, cropped to its box, so
 * the choice is made by looking.
 */

interface Candidate {
  trackId: string;
  videoId: string;
  className: string;
  seconds: number;
  samples: number;
  confidence: number;
  previewTs: number;
  thumbIndex: number;
  box: { x: number; y: number; w: number; h: number };
  sourceWidth: number;
  sourceHeight: number;
}

interface Athlete {
  id: string;
  name: string | null;
  jerseyNumber: string | null;
  isFocal: boolean;
  focalTrackId: string | null;
}

const clock = (seconds: number): string => {
  const total = Math.max(0, Math.round(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
};

/** Box in source pixels → a window onto the thumbnail, which is 180px tall. */
const cropStyle = (candidate: Candidate, base: string): string => {
  const THUMB_HEIGHT = 180;
  const scale = THUMB_HEIGHT / candidate.sourceHeight;
  const thumbWidth = candidate.sourceWidth * scale;

  // Pad the box so the crop shows a person rather than a tight rectangle.
  const pad = 0.35;
  const w = Math.max(24, candidate.box.w * scale * (1 + pad));
  const h = Math.max(32, candidate.box.h * scale * (1 + pad));
  const x = candidate.box.x * scale - (w - candidate.box.w * scale) / 2;
  const y = candidate.box.y * scale - (h - candidate.box.h * scale) / 2;

  // Scale the crop up to a consistent tile height so small figures stay visible.
  const zoom = Math.min(3, Math.max(1, 96 / h));
  const url = `${base}/videos/${candidate.videoId}/thumb/${candidate.thumbIndex}`;

  return [
    `width:${Math.round(w * zoom)}px`,
    `height:${Math.round(h * zoom)}px`,
    `background-image:url('${url}')`,
    `background-size:${Math.round(thumbWidth * zoom)}px ${Math.round(THUMB_HEIGHT * zoom)}px`,
    `background-position:-${Math.round(x * zoom)}px -${Math.round(y * zoom)}px`,
    'background-repeat:no-repeat',
  ].join(';');
};

const Identify = ({ base }: { base: string }) => {
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [athletes, setAthletes] = useState<Athlete[]>([]);
  const [athleteId, setAthleteId] = useState<string>('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const load = async (): Promise<void> => {
    try {
      const response = await fetch(`${base}/candidates`, {
        headers: { accept: 'application/json' },
      });
      const body = (await response.json()) as {
        ok: boolean;
        candidates?: Candidate[];
        athletes?: Athlete[];
        error?: string;
      };
      if (!response.ok || !body.ok) throw new Error(body.error ?? 'Could not load candidates.');
      setCandidates(body.candidates ?? []);
      setAthletes(body.athletes ?? []);
      const focal = (body.athletes ?? []).find((a) => a.isFocal) ?? (body.athletes ?? [])[0];
      if (focal !== undefined) setAthleteId(focal.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoaded(true);
    }
  };

  useEffect(() => {
    void load();
  }, [base]);

  const choose = async (candidate: Candidate): Promise<void> => {
    /**
     * No athlete yet is not a reason to refuse — it is the ordinary first-run
     * state, and refusing here left the only mandatory step in the product with
     * no way to complete it. `new` creates the athlete server-side, so picking a
     * face is the entire setup.
     */
    const target = athleteId === '' ? 'new' : athleteId;
    setBusy(candidate.trackId);
    setError(null);
    try {
      const response = await fetch(`${base}/athletes/${target}/track`, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({ trackId: candidate.trackId }),
      });
      const body = (await response.json()) as { ok: boolean; error?: string };
      if (!response.ok || !body.ok) throw new Error(body.error ?? 'Could not save that choice.');
      // Re-scoring runs in the background; the job log shows it finishing.
      window.location.assign(`${base}?ok=${encodeURIComponent('Athlete identified — re-scoring')}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusy(null);
    }
  };

  if (!loaded) return <p class="muted">Loading tracked players…</p>;

  const bound = athletes.find((athlete) => athlete.focalTrackId !== null);

  return (
    <div>
      {bound === undefined ? null : (
        <p class="notice">
          {bound.name ?? 'Your athlete'} is bound to a tracked player. Choosing another replaces it.
        </p>
      )}

      {athletes.length === 0 ? (
        <p class="muted">Click your athlete below — we'll create them for you.</p>
      ) : (
        <div class="row" style="margin-bottom:.75rem">
          <label for="who" style="margin:0">
            Identifying
          </label>
          <select
            id="who"
            style="font:inherit;padding:.35rem;border-radius:.4rem"
            onChange={(event: Event) => setAthleteId((event.target as HTMLSelectElement).value)}
          >
            {athletes.map((athlete) => (
              <option key={athlete.id} value={athlete.id} selected={athlete.id === athleteId}>
                {athlete.name ?? '(unnamed)'}
                {athlete.jerseyNumber === null ? '' : ` #${athlete.jerseyNumber}`}
              </option>
            ))}
          </select>
        </div>
      )}

      {error === null ? null : <p class="pill reject upload-error">{error}</p>}

      {candidates.length === 0 ? (
        <p class="muted">
          No tracked players yet. Run analysis first — detection is what produces the people to
          choose between.
        </p>
      ) : (
        <>
          <p class="muted">
            {candidates.length} tracked player(s), longest on screen first. Click the one that is
            your athlete.
          </p>
          <div class="candidate-grid">
            {candidates.map((candidate) => (
              <button
                type="button"
                class={`candidate${bound?.focalTrackId === candidate.trackId ? ' chosen' : ''}`}
                key={candidate.trackId}
                disabled={busy !== null}
                onClick={() => void choose(candidate)}
                title={`${candidate.seconds}s on screen, ${candidate.samples} samples, confidence ${candidate.confidence}`}
              >
                <span class="candidate-crop" style={cropStyle(candidate, base)} />
                <span class="candidate-meta">
                  {clock(candidate.previewTs)} · {candidate.seconds}s
                </span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
};

export const mountIdentify = (): void => {
  const node = document.getElementById('identify-athlete');
  if (node === null) return;
  const base = node.dataset['base'];
  if (base === undefined) return;

  node.innerHTML = '';
  render(<Identify base={base} />, node);
};
