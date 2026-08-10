/**
 * Detection boxes, drawn over the moment you are watching.
 *
 * "It hasn't really detected anybody" is not answerable from track counts, and
 * the more important question hiding behind it — is the thing being followed
 * actually my child? — is not answerable from them either. Both take about a
 * second once the boxes are on the footage.
 *
 * Drawn on a canvas from track data rather than burned into a re-encoded video:
 * nothing to render, nothing to wait for, and the focal athlete can be picked
 * out from everyone else. Boxes are stored in source pixels and the player is
 * showing a 540p proxy, so everything scales against the frame size the server
 * reports rather than whatever the element happens to be sized at.
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

/** How far from the current time a sample may be and still be drawn. */
const MAX_STALENESS = 0.35;

const COLORS: Record<string, string> = {
  ball: '#ffb000',
  hoop: '#00d0ff',
  referee: '#b070ff',
  player: '#7a7a7a',
};

const sampleAt = (track: Track, ts: number): Sample | null => {
  let best: Sample | null = null;
  let bestGap = MAX_STALENESS;
  for (const sample of track.samples) {
    const gap = Math.abs(sample.ts - ts);
    if (gap <= bestGap) {
      bestGap = gap;
      best = sample;
    }
  }
  return best;
};

const attach = (node: HTMLElement): void => {
  const video = node.querySelector('video');
  const url = node.dataset['video'];
  const start = Number(node.dataset['start']);
  const end = Number(node.dataset['end']);
  if (video === null || url === undefined || !Number.isFinite(start)) return;

  const canvas = document.createElement('canvas');
  canvas.style.cssText =
    'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;border-radius:.4rem';
  node.appendChild(canvas);

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.textContent = 'Hide boxes';
  toggle.style.cssText = 'margin-top:.4rem';
  node.appendChild(toggle);

  const caption = document.createElement('span');
  caption.className = 'muted';
  caption.style.cssText = 'margin-left:.6rem';
  node.appendChild(caption);

  let data: TrackData | null = null;
  let shown = true;
  let loading = false;

  const load = async (): Promise<void> => {
    if (data !== null || loading) return;
    loading = true;
    try {
      const response = await fetch(`${url}?from=${start - 1}&to=${end + 1}`, {
        headers: { accept: 'application/json' },
      });
      const body = (await response.json()) as TrackData;
      if (body.ok) {
        data = body;
        const focal = body.tracks.filter((track) => track.focal).length;
        const balls = body.tracks.filter((track) => track.className === 'ball').length;
        caption.textContent =
          `${body.tracks.length} tracked here` +
          (focal > 0 ? `, ${focal} is your athlete` : ', none of them marked as your athlete') +
          (balls > 0 ? `, ${balls} ball` : ', no ball seen');
      }
    } catch {
      caption.textContent = 'Could not load what was detected.';
    } finally {
      loading = false;
    }
  };

  const draw = (): void => {
    const context = canvas.getContext('2d');
    if (context === null) return;

    const width = video.clientWidth;
    const height = video.clientHeight;
    if (width === 0 || height === 0) return;
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    context.clearRect(0, 0, width, height);
    if (data === null || !shown) return;

    const scaleX = width / data.frameWidth;
    const scaleY = height / data.frameHeight;
    const ts = video.currentTime;

    for (const track of data.tracks) {
      const sample = sampleAt(track, ts);
      if (sample === null) continue;

      // The athlete is the point of the whole product, so they are unmissable
      // and everyone else is deliberately quiet.
      const color = track.focal ? '#38d95b' : (COLORS[track.className] ?? '#7a7a7a');
      context.lineWidth = track.focal ? 3 : 1;
      context.strokeStyle = color;
      context.globalAlpha = track.focal || track.className !== 'player' ? 1 : 0.45;
      context.strokeRect(sample.x * scaleX, sample.y * scaleY, sample.w * scaleX, sample.h * scaleY);

      if (track.focal || track.className === 'ball' || track.className === 'hoop') {
        context.globalAlpha = 1;
        context.fillStyle = color;
        context.font = '600 12px system-ui, sans-serif';
        const label = track.focal ? 'your athlete' : track.className;
        context.fillText(label, sample.x * scaleX, Math.max(12, sample.y * scaleY - 4));
      }
    }
    context.globalAlpha = 1;
  };

  let frame = 0;
  const loop = (): void => {
    draw();
    frame = requestAnimationFrame(loop);
  };

  video.addEventListener('play', () => {
    void load().then(loop);
  });
  video.addEventListener('loadeddata', () => void load().then(draw));
  video.addEventListener('seeked', draw);
  video.addEventListener('pause', draw);
  window.addEventListener('resize', draw);

  toggle.addEventListener('click', () => {
    shown = !shown;
    toggle.textContent = shown ? 'Hide boxes' : 'Show boxes';
    if (!shown && frame !== 0) cancelAnimationFrame(frame);
    if (shown) loop();
    else draw();
  });
};

export const mountOverlays = (): void => {
  const nodes = document.querySelectorAll<HTMLElement>('.moment-player');
  // Array.from rather than for..of: the DOM lib target here does not give
  // NodeListOf an iterator.
  for (const node of Array.from(nodes)) attach(node);
};
