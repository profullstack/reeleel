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

/**
 * Shirt colours the matcher can actually hold a track to.
 *
 * Kept in step with `JERSEY_BINS` in `packages/core/src/stitch.ts` by
 * `jerseycolours.test.ts`, which fails if the two drift apart — a colour offered
 * here that the matcher cannot bin would be a promise the panel's own copy makes
 * and nothing keeps.
 */
export const JERSEY_COLOURS = [
  'white',
  'black',
  'grey',
  'red',
  'orange',
  'yellow',
  'green',
  'teal',
  'blue',
  'navy',
  'purple',
  'pink',
  'maroon',
  'gold',
  'silver',
] as const;

export interface Candidate {
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
export interface Match {
  score: number;
  gapSeconds: number;
  distancePx: number;
}

/** One upload, named so a crop from the test clip is not read as the game. */
export interface VideoRef {
  id: string;
  label: string;
  order: number;
}

interface Athlete {
  id: string;
  name: string | null;
  jerseyNumber: string | null;
  team: string | null;
  jerseyColor: string | null;
  isFocal: boolean;
  focalTrackId: string | null;
}

/**
 * "#14 in white" — how a parent actually points at their own child.
 *
 * A number alone is ambiguous: both teams have a 14 and they are frequently on
 * court at the same time. The colour is the part you can see in the footage.
 */
const describe = (athlete: Athlete): string => {
  const parts: string[] = [];
  if (athlete.name !== null && athlete.name.length > 0) parts.push(athlete.name);
  if (athlete.jerseyNumber !== null) parts.push(`#${athlete.jerseyNumber}`);
  if (athlete.jerseyColor !== null) parts.push(`in ${athlete.jerseyColor}`);
  if (athlete.team !== null) parts.push(`(${athlete.team})`);
  return parts.length > 0 ? parts.join(' ') : '(unnamed)';
};

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

/**
 * Proposals become tiles.
 *
 * A proposal the grid cannot draw is a number going up and nothing else. The
 * grid shows the forty longest tracks; stitching works down to a quarter of a
 * second, so most of what it finds was never on screen — the count moved, no
 * new crop appeared, and the only honest reading was that the button did
 * nothing. The server sends each proposal's preview for exactly this.
 */
export const withProposals = (
  current: Candidate[],
  proposals: (Candidate & Match)[],
): Candidate[] => {
  const known = new Set(current.map((candidate) => candidate.trackId));
  const additions = proposals
    .filter((proposal) => !known.has(proposal.trackId))
    .map(({ score: _score, gapSeconds: _gap, distancePx: _px, ...candidate }) => candidate);
  return additions.length === 0 ? current : [...current, ...additions];
};

/**
 * How much of the game the current selection actually follows.
 *
 * Counted over everything picked, and it says so when some of it has no tile:
 * this read "89s" beside "30 selected" because it silently summed only the four
 * fragments the grid happened to be drawing, and the other twenty-six — from an
 * earlier upload — were invisible to both numbers.
 */
export const coverageOf = (
  candidates: Candidate[],
  picked: string[],
  videos: VideoRef[],
): string => {
  if (picked.length === 0) return 'Nothing selected yet.';

  const chosen = candidates.filter((candidate) => picked.includes(candidate.trackId));
  const seconds = chosen.reduce((sum, candidate) => sum + candidate.seconds, 0);
  const withoutPreview = picked.length - chosen.length;

  /** Where those seconds are, when there is more than one upload to confuse. */
  const perVideo =
    videos.length < 2
      ? ''
      : ` (${videos
          .map((video) => ({
            label: video.label,
            seconds: chosen
              .filter((candidate) => candidate.videoId === video.id)
              .reduce((sum, candidate) => sum + candidate.seconds, 0),
          }))
          .filter((entry) => entry.seconds > 0)
          .map((entry) => `${Math.round(entry.seconds)}s in ${entry.label}`)
          .join(', ')})`;

  return `${Math.round(seconds)}s of footage followed${perVideo}.${
    withoutPreview > 0 ? ` ${withoutPreview} more selected with no preview frame.` : ''
  }`;
};

const Identify = ({ base }: { base: string }) => {
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [athletes, setAthletes] = useState<Athlete[]>([]);
  /** The project's uploads, so a tile can say which one it came from. */
  const [videos, setVideos] = useState<VideoRef[]>([]);
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
  /** Who this is, collected alongside the picking rather than in a second form. */
  const [name, setName] = useState('');
  const [jerseyNumber, setJerseyNumber] = useState('');
  const [jerseyColor, setJerseyColor] = useState('');
  const [team, setTeam] = useState('');
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
        videos?: VideoRef[];
        error?: string;
      };
      if (!response.ok || !body.ok) throw new Error(body.error ?? 'Could not load candidates.');
      setCandidates(body.candidates ?? []);
      setAthletes(body.athletes ?? []);
      setVideos(body.videos ?? []);
      const focal = (body.athletes ?? []).find((a) => a.isFocal) ?? (body.athletes ?? [])[0];
      if (focal !== undefined) {
        setAthleteId(focal.id);
        // Seed the identity fields so they read as an edit, not a blank form.
        setName(focal.name ?? '');
        setJerseyNumber(focal.jerseyNumber ?? '');
        setJerseyColor(focal.jerseyColor ?? '');
        setTeam(focal.team ?? '');
      }
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
        searchedVideoIds?: string[];
        skippedVideos?: { videoId: string; reason: string }[];
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
      setCandidates((current) => withProposals(current, proposals));
      setPicked((current) => [
        ...current,
        ...proposals.map((p) => p.trackId).filter((id) => !current.includes(id)),
      ]);
      const searched = body.searchedVideoIds ?? [];
      const skipped = body.skippedVideos ?? [];
      const across =
        videos.length > 1 && searched.length > 0
          ? ` Searched ${searched.length} of ${videos.length} video(s) — a video is only searched where your athlete is already marked in it.`
          : '';
      const unread =
        skipped.length === 0
          ? ''
          : ` ${skipped.length} video(s) could not be read: ${skipped.map((s) => s.reason).join('; ')}`;
      setFound(
        (proposals.length === 0
          ? `Nothing else followed on from where your athlete was, out of ${body.considered ?? 0} tracks checked. Pick any more you recognise by hand.`
          : `Followed your athlete into ${proposals.length} more fragment(s), out of ${body.considered ?? 0} checked, and selected them. Each one carries on from where a fragment you already have left off, in a matching shirt — check them and untick anything that is not them.`) +
          across +
          unread,
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
        body: JSON.stringify({ trackId: picked[0], trackIds: picked, name, jerseyNumber, jerseyColor, team }),
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

  const coverage = coverageOf(candidates, picked, videos);

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
                {describe(athlete)}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Collected here rather than in a separate "Add an athlete" form, because
          this is the moment the user is looking at the child and knows the
          answer. All optional: pointing at the right player is the only thing
          scoring actually needs. */}
      <div class="row identity-fields" style="margin-bottom:.75rem;gap:.5rem;flex-wrap:wrap">
        <input
          type="text"
          placeholder="Name (optional)"
          value={name}
          onInput={(event: Event) => setName((event.target as HTMLInputElement).value)}
          style="font:inherit;padding:.35rem;border-radius:.4rem;max-width:11rem"
        />
        <input
          type="text"
          placeholder="#14"
          value={jerseyNumber}
          onInput={(event: Event) => setJerseyNumber((event.target as HTMLInputElement).value)}
          style="font:inherit;padding:.35rem;border-radius:.4rem;max-width:5rem"
        />
        <input
          type="text"
          list="jersey-colours"
          placeholder="Shirt colour, e.g. white"
          value={jerseyColor}
          onInput={(event: Event) => setJerseyColor((event.target as HTMLInputElement).value)}
          style="font:inherit;padding:.35rem;border-radius:.4rem;max-width:12rem"
        />
        {/*
          Free text still works — an unrecognised word simply leaves matching as
          permissive as it was, rather than rejecting every child in the game.
          The list is here because a colour the matcher has no bins for is a
          colour it cannot hold anyone to, and "teal" is help nobody can guess.
          Mirrors JERSEY_BINS in packages/core/src/stitch.ts.
        */}
        <datalist id="jersey-colours">
          {JERSEY_COLOURS.map((colour) => (
            <option key={colour} value={colour} />
          ))}
        </datalist>
        <input
          type="text"
          placeholder="Team (optional)"
          value={team}
          onInput={(event: Event) => setTeam((event.target as HTMLInputElement).value)}
          style="font:inherit;padding:.35rem;border-radius:.4rem;max-width:11rem"
        />
      </div>
      <p class="muted" style="margin-top:-.35rem">
        Both teams have a #14. The shirt colour is what tells them apart — and what
        the matcher uses when it looks for the same child elsewhere in the game.
      </p>

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
            {candidates.length} tracked player(s), longest on screen first — everything already
            selected is shown here too, however short, so it can be taken back. Click{' '}
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
                      {/* Which upload this crop is from. Only shown when there
                          is more than one, because otherwise it is noise. */}
                      {videos.length < 2
                        ? ''
                        : ` · ${videos.find((video) => video.id === candidate.videoId)?.label ?? 'video'}`}
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
