import { mountReview } from './review.js';

/**
 * Bringing the page up to date without reloading it.
 *
 * The pages are server-rendered and must keep working with no JavaScript, so
 * the server stays the single source of truth — there is no client router and
 * no client-side view model to keep in sync. What there was instead was
 * `window.location.reload()`, fired 1.5 seconds after any job finished, plus a
 * "Analysis is running. Refresh for progress." link for the rest of the time.
 *
 * That is what made the app feel broken to a new user: the page moved under
 * them without being asked, they lost their place, and between refreshes there
 * was no way to tell whether to wait or to click again. Clicking again is
 * exactly what produced seven duplicate athletes — the reloads were racing the
 * clicks.
 *
 * So: fetch the same URL the user is already on, and swap only the regions
 * marked `data-live`. The server renders them exactly as it always did, the
 * islands that own state (the job log holding an EventSource, the identify
 * grid holding a half-finished selection) are never inside one, and nothing
 * scrolls.
 */

/** Islands that live inside a swappable region and must be re-mounted after it. */
const REMOUNT: Record<string, () => void> = {
  moments: mountReview,
};

let inFlight: Promise<void> | null = null;

/**
 * Replaces every `data-live` region with the server's current version.
 *
 * Coalesced: several finishing jobs, or a save and a job completing together,
 * should cost one fetch and one repaint rather than three.
 */
export const refreshLive = async (): Promise<void> => {
  if (inFlight !== null) return inFlight;

  inFlight = (async () => {
    try {
      const response = await fetch(window.location.href, {
        headers: { accept: 'text/html' },
        credentials: 'same-origin',
      });
      if (!response.ok) return;
      const parsed = new DOMParser().parseFromString(await response.text(), 'text/html');

      // Array.from rather than iterating the NodeList: the DOM lib this project
      // compiles against does not give NodeListOf an iterator.
      for (const current of Array.from(document.querySelectorAll<HTMLElement>('[data-live]'))) {
        const key = current.dataset['live'];
        if (key === undefined) continue;
        const fresh = parsed.querySelector<HTMLElement>(`[data-live="${key}"]`);
        // A region that has gone away entirely is left alone rather than
        // blanked: an empty page is a worse lie than a stale one.
        if (fresh === null) continue;
        if (fresh.innerHTML === current.innerHTML) continue;
        current.innerHTML = fresh.innerHTML;
        REMOUNT[key]?.();
      }
    } catch {
      // Offline, or the session expired. The page is stale, which is survivable;
      // throwing here would take an island down with it.
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
};

type Listener = () => void;
const listeners = new Set<Listener>();

/** Something changed the project; islands that show its data should catch up. */
export const emitChanged = (): void => {
  for (const listener of listeners) listener();
  void refreshLive();
};

export const onChanged = (listener: Listener): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
