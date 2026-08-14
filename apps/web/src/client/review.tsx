/**
 * The review surface: every track drawn over the whole game, and a click that
 * says "that one is my child".
 *
 * Identification was previously a grid of the *longest* tracks. On footage that
 * fragments into thousands, the longest are a coach, the referee and whoever
 * stood still longest — so it offered a page of strangers and no way to say
 * "not those, him". Pointing at the boy on screen needs no explanation and
 * cannot be misread.
 *
 * Tracks are fetched in windows rather than all at once: a five-minute game
 * holds hundreds of thousands of samples, and the browser only ever needs the
 * few seconds around the playhead.
 */

interface Sample {
  ts: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Track {
  id: string;
  className: string;
  focal: boolean;
  samples: Sample[];
}

interface TrackData {
  ok: boolean;
  frameWidth: number;
  frameHeight: number;
  tracks: Track[];
}

/** Seconds of track data fetched around the playhead in one go. */
const WINDOW = 20;
/** How stale a sample may be and still be drawn. */
const MAX_STALENESS = 0.35;

const COLORS: Record<string, string> = {
  ball: '#ffb000',
  hoop: '#00d0ff',
  referee: '#b070ff',
  player: '#9a9a9a',
};

const sampleAt = (track: Track, ts: number): Sample | null => {
  let best: Sample | null = null;
  let gap = MAX_STALENESS;
  for (const sample of track.samples) {
    const distance = Math.abs(sample.ts - ts);
    if (distance <= gap) {
      gap = distance;
      best = sample;
    }
  }
  return best;
};

/** Height reserved for the native player controls at the bottom of the video. */
export const CONTROL_STRIP = '3.5rem';

/**
 * The canvas never takes the pointer. It covers the whole video including the
 * play button and the scrubber, and the first version of this page could not be
 * played at all because those controls sat underneath a click target.
 */
export const CANVAS_STYLE =
  'position:absolute;inset:0;width:100%;height:100%;border-radius:.4rem;pointer-events:none';

/**
 * Clicks land here instead, and only while identifying. It stops short of the
 * control strip so playback stays reachable even mid-selection.
 */
export const HIT_STYLE =
  `position:absolute;left:0;right:0;top:0;bottom:${CONTROL_STRIP};cursor:crosshair;display:none`;

const attach = (node: HTMLElement): void => {
  const video = node.querySelector('video');
  const tracksUrl = node.dataset['tracks'];
  const bindUrl = node.dataset['bind'];
  if (video === null || tracksUrl === undefined || bindUrl === undefined) return;

  /**
   * Boxes are drawn on top of the video, so the canvas covers the play button
   * and the scrubber too. Left clickable it swallows both: the first version
   * of this page could not be played at all, because the control that starts
   * playback was underneath a click target for selecting a player.
   *
   * So the canvas ignores the pointer by default and only accepts clicks while
   * identifying, and even then it stops short of the control strip.
   */
  const canvas = document.createElement('canvas');
  canvas.style.cssText = CANVAS_STYLE;
  node.appendChild(canvas);

  /**
   * Clicks land here, not on the canvas: the canvas must stay exactly the size
   * of the video or every box is drawn in the wrong place, while the hit layer
   * needs to stop above the controls. Two elements, two jobs.
   */
  const hit = document.createElement('div');
  hit.style.cssText = HIT_STYLE;
  node.appendChild(hit);

  const controls = document.createElement('div');
  controls.className = 'row';
  controls.style.cssText = 'margin-top:.5rem;align-items:center;gap:.6rem';
  const identify = document.createElement('button');
  identify.type = 'button';
  identify.textContent = 'Identify my athlete';
  controls.appendChild(identify);

  /**
   * Who this is, asked where the user is already looking at them.
   *
   * A number alone does not name a child — both teams field a 14 and they are
   * on court together — so the shirt colour is the part a parent actually uses.
   * Asking here rather than on a separate panel is the difference between the
   * fields being filled in and being skipped: production has a child recorded
   * as team "Triton (white)" because the only form that offered a colour was
   * one the user never reached, so they crammed it into the team box.
   */
  const field = (placeholder: string, width: string): HTMLInputElement => {
    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = placeholder;
    input.style.cssText = `width:${width};flex:none`;
    controls.appendChild(input);
    return input;
  };
  const nameInput = field('Name', '8rem');
  const numberInput = field('#', '3.5rem');
  const colorInput = field('Shirt colour', '7rem');
  const teamInput = field('Team', '7rem');

  /** Only send what was actually typed; blank fields must not erase a name. */
  const identity = (): Record<string, string> => {
    const parts: Record<string, string> = {};
    if (nameInput.value.trim() !== '') parts['name'] = nameInput.value.trim();
    if (numberInput.value.trim() !== '') parts['jerseyNumber'] = numberInput.value.trim();
    if (colorInput.value.trim() !== '') parts['jerseyColor'] = colorInput.value.trim();
    if (teamInput.value.trim() !== '') parts['team'] = teamInput.value.trim();
    return parts;
  };

  /** Shown only while a bind is in flight, because that one really does wait. */
  const spinner = document.createElement('progress');
  spinner.style.cssText = 'display:none;width:8rem;flex:none';
  controls.appendChild(spinner);
  node.appendChild(controls);

  const setPending = (on: boolean): void => {
    spinner.style.display = on ? 'block' : 'none';
    identify.disabled = on;
  };

  const status = document.createElement('p');
  status.className = 'muted';
  node.appendChild(status);

  let identifying = false;
  const setIdentifying = (on: boolean): void => {
    identifying = on;
    identify.textContent = on ? 'Cancel' : 'Identify my athlete';
    hit.style.display = on ? 'block' : 'none';
    if (on) {
      video.pause();
      status.textContent =
        'Now click the box drawn around your athlete. The play controls still work below.';
    } else {
      draw();
    }
  };
  identify.addEventListener('click', () => setIdentifying(!identifying));

  let data: TrackData | null = null;
  let windowStart = Number.NaN;
  let loading = false;
  let busy = false;

  const ensure = async (ts: number): Promise<void> => {
    const bucket = Math.floor(ts / WINDOW) * WINDOW;
    if (bucket === windowStart || loading) return;
    loading = true;
    try {
      const response = await fetch(`${tracksUrl}?from=${bucket}&to=${bucket + WINDOW}`, {
        headers: { accept: 'application/json' },
      });
      const body = (await response.json()) as TrackData;
      if (body.ok) {
        data = body;
        windowStart = bucket;
      }
    } catch {
      status.textContent = 'Could not load tracks for this part of the video.';
    } finally {
      loading = false;
    }
  };

  /** Boxes visible right now, smallest last so a click prefers the tighter one. */
  const visible = (): { track: Track; sample: Sample }[] => {
    if (data === null) return [];
    const ts = video.currentTime;
    const found: { track: Track; sample: Sample }[] = [];
    for (const track of data.tracks) {
      const sample = sampleAt(track, ts);
      if (sample !== null) found.push({ track, sample });
    }
    return found.sort((a, b) => b.sample.w * b.sample.h - a.sample.w * a.sample.h);
  };

  const draw = (): void => {
    const context = canvas.getContext('2d');
    if (context === null || data === null) return;
    const width = video.clientWidth;
    const height = video.clientHeight;
    if (width === 0 || height === 0) return;
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }

    const scaleX = width / data.frameWidth;
    const scaleY = height / data.frameHeight;
    context.clearRect(0, 0, width, height);

    const boxes = visible();
    for (const { track, sample } of boxes) {
      const color = track.focal ? '#38d95b' : (COLORS[track.className] ?? '#9a9a9a');
      context.lineWidth = track.focal ? 4 : 2;
      context.strokeStyle = color;
      context.globalAlpha = track.focal || track.className !== 'player' ? 1 : 0.9;
      context.strokeRect(sample.x * scaleX, sample.y * scaleY, sample.w * scaleX, sample.h * scaleY);
      if (track.focal || track.className !== 'player') {
        context.globalAlpha = 1;
        context.fillStyle = color;
        context.font = '600 12px system-ui, sans-serif';
        context.fillText(
          track.focal ? 'your athlete' : track.className,
          sample.x * scaleX,
          Math.max(12, sample.y * scaleY - 4),
        );
      }
    }
    context.globalAlpha = 1;

    const people = boxes.filter((b) => b.track.className === 'player').length;
    const bound = boxes.some((b) => b.track.focal);
    status.textContent =
      `${people} person(s) tracked at ${video.currentTime.toFixed(1)}s` +
      (bound
        ? ' — your athlete is one of them.'
        : identifying
          ? ' — click the box around your athlete.'
          : ' — drag the progress bar to find them, then press Identify my athlete.');
  };

  const tick = (): void => {
    void ensure(video.currentTime).then(draw);
  };

  const bind = async (trackId: string): Promise<void> => {
    if (busy) return;
    busy = true;
    /**
     * Expanding decodes frames, so this is the one click on the page with a
     * real wait behind it. Say what is happening rather than leaving a dead
     * button: not knowing whether to wait or click again is what produced eight
     * athletes in three minutes.
     */
    setPending(true);
    status.textContent = 'Following them through the rest of the game…';
    try {
      const response = await fetch(bindUrl, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({
          trackId,
          trackIds: [trackId],
          // One click should mark the child everywhere they appear from here,
          // not only in the fragment under the cursor.
          expand: true,
          // …everywhere in *this* video. Expansion used to be told nothing
          // about which footage was on screen, and now that it can open every
          // upload, saying so is what keeps a click on the game from quietly
          // adding fragments of last week's clip.
          ...(node.dataset['video'] === undefined ? {} : { videoId: node.dataset['video'] }),
          ...identity(),
        }),
      });
      const body = (await response.json()) as { ok: boolean; error?: string; added?: number };
      if (!response.ok || !body.ok) throw new Error(body.error ?? 'Could not bind that track.');
      // Re-fetch so the box turns green without a reload.
      windowStart = Number.NaN;
      await ensure(video.currentTime);
      draw();
      setIdentifying(false);
      const added = body.added ?? 0;
      status.textContent =
        (added > 0
          ? `Identified, and followed them into ${added} more fragment(s) of the game. `
          : 'Identified. ') + 'Re-scoring now — suggested moments will update on their own.';
    } catch (cause) {
      status.textContent = cause instanceof Error ? cause.message : String(cause);
    } finally {
      setPending(false);
      busy = false;
    }
  };

  hit.addEventListener('click', (event) => {
    if (data === null) return;
    // Measured against the canvas, which is the full video rectangle — the hit
    // layer is deliberately shorter, so using its box would skew every click.
    const rect = canvas.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * data.frameWidth;
    const y = ((event.clientY - rect.top) / rect.height) * data.frameHeight;

    // Smallest containing box wins: a click inside a child standing in front of
    // a wide crowd box should pick the child.
    const hit = visible()
      .filter(
        ({ sample }) =>
          x >= sample.x && x <= sample.x + sample.w && y >= sample.y && y <= sample.y + sample.h,
      )
      .pop();
    if (hit === undefined) {
      status.textContent = 'Nothing tracked there — try a frame where they are clearly visible.';
      return;
    }
    void bind(hit.track.id);
  });

  video.addEventListener('loadeddata', tick);
  video.addEventListener('seeked', tick);
  video.addEventListener('pause', tick);
  video.addEventListener('timeupdate', tick);
  window.addEventListener('resize', draw);
  tick();
};

export const mountReview = (): void => {
  const node = document.getElementById('review-surface');
  if (node === null) return;
  /**
   * Attach once. This is called again after a live region is swapped, and
   * attaching twice appends a second canvas, a second set of fields and a
   * second Identify button over the same video — the duplicate-surface bug in
   * miniature, and the kind that only shows up after the page has been open
   * long enough for something to refresh.
   */
  if (node.dataset['mounted'] === 'true') return;
  node.dataset['mounted'] = 'true';
  attach(node);
};
