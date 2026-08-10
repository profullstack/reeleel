/** @jsxImportSource hono/jsx/dom */
import { render, useEffect, useState } from 'hono/jsx/dom';

import { emitChanged } from './live.js';

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

/** Why the server thinks a fragment continues the athlete. */
interface Match {
  score: number;
  gapSeconds: number;
  distancePx: number;
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
  /** Every fragment the user says is their athlete, not just the last clicked. */
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  /**
   * Appearance scores for tracks the server thinks are the same child, keyed by
   * track id. Picking by hand only labels the athlete where the user happened
   * to look — on a real game that was 31.7s out of 300.
   */
  const [scores, setScores] = useState<Record<string, Match>>({});
  const [finding, setFinding] = useState(false);
  const [found, setFound] = useState<string | null>(null);
  /** What just happened, said here rather than via a redirect and a flash. */
  const [saved, setSaved] = useState<string | null>(null);

  const load = async (): Promise<void> => {
    try {
      const response = await fetch(`${base}/candidates`, {
        headers: { accept: 'application/json' },
      });
      const body = (await response.json()) as {
        ok: boolean;
        candidates?: Candidate[];
        athletes?: Athlete[];
        assignedTrackIds?: string[];
        error?: string;
      };
      if (!response.ok || !body.ok) throw new Error(body.error ?? 'Could not load candidates.');
      setCandidates(body.candidates ?? []);
      setAthletes(body.athletes ?? []);
      const focal = (body.athletes ?? []).find((a) => a.isFocal) ?? (body.athletes ?? [])[0];
      if (focal !== undefined) setAthleteId(focal.id);
      // Reopen with the existing choice selected, so adding a fragment is an
      // edit rather than starting over.
      const already = body.assignedTrackIds ?? [];
      setPicked(already.length > 0 ? already : focal?.focalTrackId ? [focal.focalTrackId] : []);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoaded(true);
    }
  };

  useEffect(() => {
    void load();
  }, [base]);

  const toggle = (trackId: string): void => {
    setPicked((current) =>
      current.includes(trackId)
        ? current.filter((id) => id !== trackId)
        : [...current, trackId],
    );
  };

  /**
   * Ask the server to find this child in the rest of the footage by the colour
   * of their shirt. Matches are selected, not applied: the grid shows them
   * ticked so a human confirms before anything is bound, because the cost of a
   * confident wrong answer is another family's child in the reel.
   */
  const findRest = async (): Promise<void> => {
    setFinding(true);
    setError(null);
    setFound(null);
    try {
      const response = await fetch(`${base}/athletes/${athleteId}/suggestions`, {
        headers: { accept: 'application/json' },
      });
      const body = (await response.json()) as {
        ok: boolean;
        proposals?: (Candidate & Match)[];
        considered?: number;
        error?: string;
      };
      if (!response.ok || !body.ok) throw new Error(body.error ?? 'Could not search the footage.');

      const proposals = body.proposals ?? [];
      setScores(
        Object.fromEntries(
          proposals.map((p) => [
            p.trackId,
            { score: p.score, gapSeconds: p.gapSeconds, distancePx: p.distancePx },
          ]),
        ),
      );
      setPicked((current) => [
        ...current,
        ...proposals.map((p) => p.trackId).filter((id) => !current.includes(id)),
      ]);
      setFound(
        proposals.length === 0
          ? `Nothing else followed on from where your athlete was, out of ${body.considered ?? 0} tracks checked. Pick any more you recognise by hand.`
          : `Followed your athlete into ${proposals.length} more fragment(s), out of ${body.considered ?? 0} checked, and selected them. Each one carries on from where a fragment you already have left off, in a matching shirt — check them and untick anything that is not them.`,
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setFinding(false);
    }
  };

  const save = async (): Promise<void> => {
    /**
     * No athlete yet is not a reason to refuse — it is the ordinary first-run
     * state, and refusing here left the only mandatory step in the product with
     * no way to complete it. `new` creates the athlete server-side, so picking
     * faces is the entire setup.
     */
    const target = athleteId === '' ? 'new' : athleteId;
    setBusy(picked[0] ?? 'saving');
    setError(null);
    setSaved(null);
    try {
      const response = await fetch(`${base}/athletes/${target}/track`, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({ trackId: picked[0], trackIds: picked }),
      });
      const body = (await response.json()) as { ok: boolean; athleteId?: string; error?: string };
      if (!response.ok || !body.ok) throw new Error(body.error ?? 'Could not save that choice.');

      /**
       * Stay on the page.
       *
       * This navigated, which meant every save cost a full reload — losing the
       * grid, the scroll position and any sense of what had just happened. It
       * also raced the user: a click made before the reload landed arrived with
       * no athlete loaded, and the server minted another one. Seven duplicates
       * came from exactly this.
       */
      if (body.athleteId !== undefined) setAthleteId(body.athleteId);
      setSaved(`Identified across ${picked.length} track(s) — re-scoring now`);
      // Reload this island's own data, then let the rest of the page catch up.
      await load();
      emitChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  if (!loaded) return <p class="muted">Loading tracked players…</p>;

  /** How much of the game the current selection actually follows. */
  const chosenSeconds = candidates
    .filter((candidate) => picked.includes(candidate.trackId))
    .reduce((sum, candidate) => sum + candidate.seconds, 0);
  const coverage =
    picked.length === 0
      ? 'Nothing selected yet.'
      : `${Math.round(chosenSeconds)}s of footage followed.`;

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
      {saved === null ? null : <p class="notice">{saved}</p>}

      {candidates.length === 0 ? (
        <p class="muted">
          No tracked players yet. Run analysis first — detection is what produces the people to
          choose between.
        </p>
      ) : (
        <>
          {/* Tracking splits one child into several, so the same athlete shows
              up as several crops. Picking only one binds a fraction of them. */}
          <p class="muted">
            {candidates.length} tracked player(s), longest on screen first. Click{' '}
            <strong>every</strong> crop that is your athlete — the same child usually appears
            more than once, and each one you add is more of the game they are followed through.
          </p>
          {found === null ? null : <p class="notice">{found}</p>}
          <div class="candidate-grid">
            {/* Matches first, so the ones needing a decision are not buried
                halfway down a grid of forty strangers. */}
            {[...candidates]
              .sort((a, b) => (scores[b.trackId]?.score ?? -1) - (scores[a.trackId]?.score ?? -1))
              .map((candidate) => {
                const match = scores[candidate.trackId];
                return (
                  <button
                    type="button"
                    class={`candidate${picked.includes(candidate.trackId) ? ' chosen' : ''}`}
                    key={candidate.trackId}
                    disabled={busy !== null}
                    onClick={() => toggle(candidate.trackId)}
                    title={`${candidate.seconds}s on screen, ${candidate.samples} samples, confidence ${candidate.confidence}${
                      match === undefined
                        ? ''
                        : ` — continues the previous fragment ${match.gapSeconds.toFixed(1)}s later, ` +
                          `${match.distancePx}px away, shirt matches ${Math.round(match.score * 100)}%`
                    }`}
                  >
                    <span class="candidate-crop" style={cropStyle(candidate, base)} />
                    <span class="candidate-meta">
                      {clock(candidate.previewTs)} · {candidate.seconds}s
                      {match === undefined ? '' : ` · ${Math.round(match.score * 100)}%`}
                    </span>
                  </button>
                );
              })}
          </div>
          <div class="row" style="margin-top:.75rem;align-items:center;gap:.75rem">
            <button type="button" disabled={picked.length === 0 || busy !== null} onClick={() => void save()}>
              {busy === null
                ? `Identify as my athlete (${picked.length} selected)`
                : 'Saving…'}
            </button>
            {/* Only useful once they are bound somewhere: the search compares
                against the tracks already saved for this athlete. */}
            <button
              type="button"
              class="secondary"
              disabled={athleteId === '' || finding || busy !== null}
              onClick={() => void findRest()}
              title="Search the rest of the footage for this athlete by the colour of their shirt"
            >
              {finding ? 'Searching the footage…' : 'Find them in the rest of the game'}
            </button>
            <span class="muted">{coverage}</span>
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
