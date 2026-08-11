import { similarity } from './appearance.js';
import { iou } from './geometry.js';
import type { Box, Detection } from './geometry.js';

/**
 * ByteTrack-style multi-object tracking.
 *
 * The idea worth keeping from BYTE: do not throw away low-confidence
 * detections. Associate high-confidence boxes first, then use the leftovers to
 * rescue tracks that would otherwise be declared lost. In sport footage a
 * player who is briefly occluded by another player drops in confidence rather
 * than disappearing, and discarding those boxes is what makes naive trackers
 * swap identities constantly.
 */

export interface TrackPoint {
  frame: number;
  ts: number;
  x: number;
  y: number;
  w: number;
  h: number;
  confidence: number;
}

export interface Track {
  id: number;
  classId: number;
  className: string;
  points: TrackPoint[];
  /** Frames since the last successful association. */
  missing: number;
  confidence: number;
  velocity: { x: number; y: number };
  lastBox: Box;
  /**
   * Running mean of this track's torso colour, null until something measured
   * one. Only observations contribute, so a track that vanishes for a second
   * comes back still remembering the shirt it went away wearing.
   */
  appearance: number[] | null;
  /** How many appearance observations the mean is over. */
  appearanceCount: number;
}

export interface TrackerOptions {
  /** Detections at or above this are matched first. */
  highThreshold: number;
  /** Detections below this are ignored entirely. */
  lowThreshold: number;
  iouThreshold: number;
  /** Frames a track survives without a detection before it is closed. */
  maxAge: number;
  /** Tracks shorter than this are dropped as noise. */
  minLength: number;
  /**
   * Per-class overrides of {@link highThreshold}, keyed by class name.
   *
   * Only a *high* detection may start a track — a low one can extend a track
   * that already exists, but never open one. With a single global bar that made
   * the per-class confidence floors half a fix: letting a 0.2 ball through the
   * filter puts it in the low pile, where it can only ever attach to a ball
   * track that was already running. Since the ball is rarely seen at 0.4 at
   * all, there was usually nothing for it to attach to. That is the measured
   * shape of the problem — loosening the floor raised ball *positions* by 69%
   * while barely moving the track count, because the extra detections extended
   * the few tracks that existed rather than starting the many that did not.
   */
  classHighThreshold: Record<string, number>;
  /**
   * Per-class association buffer, keyed by class name: both boxes are grown by
   * this fraction of their own size before overlap is measured.
   *
   * Overlap is the wrong question for a thrown ball. A basketball is a small
   * box that routinely travels more than its own width between sampled frames,
   * and two boxes that do not touch have an IoU of exactly zero however close
   * they are — so association fails, the track dies, and a new one is born
   * further along the same flight. Growing both boxes first (buffered IoU)
   * restores a gradient for objects that move far relative to their size, and
   * leaves anything with a buffer of 0 — every person on court — untouched.
   */
  classBuffer: Record<string, number>;
  /**
   * Torso colour a lost track and a detection must share before they may be
   * joined, as histogram intersection in [0,1].
   *
   * Overlap alone cannot tell one child from another, and the moment that costs
   * is re-acquisition. Measured on the shipped tracker: a player standing at
   * x=900 who leaves, followed half a second later by an opponent arriving at
   * x=905, produced *one* track spanning both children — `maxAge` of 30 frames
   * tolerates a second of absence, and greedy IoU is delighted to hand the old
   * identity to whoever now occupies the space. Nothing downstream can undo
   * that: re-identification vets one track against another, so a track that is
   * already two children has no seam left to find. That is how a reel followed
   * #14 in black.
   *
   * White against black measures 0.28 on this histogram and a shirt against
   * itself close to 1.0, so the bar sits comfortably between them. It is only
   * ever applied to a track that has *missed* a frame; consecutive frames still
   * associate on geometry alone, where geometry is reliable and cheap.
   *
   * When it refuses a join the track simply ends and a new one begins, which is
   * the recoverable failure: a fragment is something the colour-vetted stitcher
   * can put back together, and a spliced identity is not.
   */
  reacquireColourFloor: number;
}

export const DEFAULT_TRACKER_OPTIONS: TrackerOptions = {
  highThreshold: 0.5,
  lowThreshold: 0.1,
  iouThreshold: 0.2,
  maxAge: 30,
  minLength: 3,
  classHighThreshold: {},
  classBuffer: {},
  reacquireColourFloor: 0.5,
};

/**
 * Whether a track may be re-attached to this detection.
 *
 * Answers "yes" whenever there is no evidence — an unmeasured detection, a
 * track that has never been seen in colour, a class nobody takes a torso from —
 * so a pipeline that supplies no appearance behaves exactly as it always did.
 */
export const appearanceAgrees = (track: Track, detection: Detection, floor: number): boolean => {
  // Consecutive frames: a box cannot have moved far, and overlap already said so.
  if (track.missing <= 0) return true;
  if (track.appearance === null) return true;
  const observed = detection.appearance;
  if (observed === undefined || observed.length === 0) return true;
  return similarity(track.appearance, observed) >= floor;
};

const centre = (box: Box): { x: number; y: number } => ({
  x: box.x + box.w / 2,
  y: box.y + box.h / 2,
});

/** Constant-velocity guess for where a track should be on this frame. */
const predict = (track: Track): Box => ({
  x: track.lastBox.x + track.velocity.x,
  y: track.lastBox.y + track.velocity.y,
  w: track.lastBox.w,
  h: track.lastBox.h,
});

interface Pair {
  trackIndex: number;
  detectionIndex: number;
  score: number;
}

const box = (detection: Detection): Box => ({
  x: detection.x,
  y: detection.y,
  w: detection.w,
  h: detection.h,
});

/**
 * Grows a box by a fraction of its own size on every side.
 *
 * A buffer of 0 returns the box unchanged, which is the point: buffering is
 * opt-in per class, so classes that do not ask for it associate on exactly the
 * geometry they always did.
 */
export const inflate = (target: Box, by: number): Box =>
  by <= 0
    ? target
    : {
        x: target.x - target.w * by,
        y: target.y - target.h * by,
        w: target.w * (1 + 2 * by),
        h: target.h * (1 + 2 * by),
      };

/**
 * Greedy IoU association. Hungarian would be optimal, but greedy-by-IoU is
 * within noise for this many objects and is far easier to reason about when a
 * track goes wrong.
 */
const associate = (
  tracks: Track[],
  detections: Detection[],
  iouThreshold: number,
  bufferFor: (track: Track) => number = () => 0,
  allow: (track: Track, detection: Detection) => boolean = () => true,
): { matches: Pair[]; unmatchedTracks: number[]; unmatchedDetections: number[] } => {
  const candidates: Pair[] = [];

  tracks.forEach((track, trackIndex) => {
    const buffer = bufferFor(track);
    const predicted = inflate(predict(track), buffer);
    detections.forEach((detection, detectionIndex) => {
      if (detection.classId !== track.classId) return;
      if (!allow(track, detection)) return;
      const score = iou(predicted, inflate(box(detection), buffer));
      if (score >= iouThreshold) candidates.push({ trackIndex, detectionIndex, score });
    });
  });

  candidates.sort((a, b) => b.score - a.score);

  const takenTracks = new Set<number>();
  const takenDetections = new Set<number>();
  const matches: Pair[] = [];

  for (const candidate of candidates) {
    if (takenTracks.has(candidate.trackIndex) || takenDetections.has(candidate.detectionIndex)) {
      continue;
    }
    takenTracks.add(candidate.trackIndex);
    takenDetections.add(candidate.detectionIndex);
    matches.push(candidate);
  }

  return {
    matches,
    unmatchedTracks: tracks.map((_, i) => i).filter((i) => !takenTracks.has(i)),
    unmatchedDetections: detections.map((_, i) => i).filter((i) => !takenDetections.has(i)),
  };
};

export class ByteTracker {
  private readonly options: TrackerOptions;
  private active: Track[] = [];
  private finished: Track[] = [];
  private nextId = 1;

  constructor(options: Partial<TrackerOptions> = {}) {
    this.options = { ...DEFAULT_TRACKER_OPTIONS, ...options };
  }

  private open(detection: Detection, className: string, frame: number, ts: number): void {
    const appearance = detection.appearance;
    const measured = appearance !== undefined && appearance.length > 0;
    this.active.push({
      id: this.nextId++,
      classId: detection.classId,
      className,
      points: [{ frame, ts, ...box(detection), confidence: detection.score }],
      missing: 0,
      confidence: detection.score,
      velocity: { x: 0, y: 0 },
      lastBox: box(detection),
      appearance: measured ? [...appearance] : null,
      appearanceCount: measured ? 1 : 0,
    });
  }

  private extend(track: Track, detection: Detection, frame: number, ts: number): void {
    const previous = centre(track.lastBox);
    const next = centre(detection);
    track.velocity = { x: next.x - previous.x, y: next.y - previous.y };
    track.lastBox = box(detection);
    track.missing = 0;
    // Running mean keeps one lucky frame from inflating a weak track.
    track.confidence = (track.confidence * track.points.length + detection.score) / (track.points.length + 1);
    track.points.push({ frame, ts, ...box(detection), confidence: detection.score });

    // The same averaging for colour, so one crop caught mid-occlusion cannot
    // redefine what this player looks like.
    const observed = detection.appearance;
    if (observed === undefined || observed.length === 0) return;
    if (track.appearance === null) {
      track.appearance = [...observed];
      track.appearanceCount = 1;
      return;
    }
    const n = track.appearanceCount;
    track.appearance = track.appearance.map(
      (value, i) => (value * n + (observed[i] ?? 0)) / (n + 1),
    );
    track.appearanceCount = n + 1;
  }

  /** Feeds one frame of detections. */
  update(detections: Detection[], classNames: Record<number, string>, frame: number, ts: number): void {
    /**
     * The bar this detection has to clear to be treated as confident — and so
     * to be allowed to start a track, not merely extend one.
     */
    const barFor = (detection: Detection): number => {
      const className = classNames[detection.classId];
      const override =
        className === undefined ? undefined : this.options.classHighThreshold[className];
      return override ?? this.options.highThreshold;
    };
    const bufferFor = (track: Track): number => this.options.classBuffer[track.className] ?? 0;
    /**
     * A track that has lost sight of its subject must recognise the shirt before
     * it is allowed to claim whoever is standing there now.
     */
    const allow = (track: Track, detection: Detection): boolean =>
      appearanceAgrees(track, detection, this.options.reacquireColourFloor);

    const usable = detections.filter((d) => d.score >= this.options.lowThreshold);
    const high = usable.filter((d) => d.score >= barFor(d));
    const low = usable.filter((d) => d.score < barFor(d));

    // Pass 1: confident detections against every live track.
    const first = associate(this.active, high, this.options.iouThreshold, bufferFor, allow);
    for (const match of first.matches) {
      const track = this.active[match.trackIndex];
      const detection = high[match.detectionIndex];
      if (track !== undefined && detection !== undefined) this.extend(track, detection, frame, ts);
    }

    // Pass 2: the BYTE step — try the leftovers against tracks that missed out,
    // with a looser bar, so an occluded player is rescued rather than lost.
    const stranded = first.unmatchedTracks.map((i) => this.active[i]).filter((t): t is Track => t !== undefined);
    const second = associate(stranded, low, this.options.iouThreshold * 0.75, bufferFor, allow);
    const rescued = new Set<Track>();
    for (const match of second.matches) {
      const track = stranded[match.trackIndex];
      const detection = low[match.detectionIndex];
      if (track !== undefined && detection !== undefined) {
        this.extend(track, detection, frame, ts);
        rescued.add(track);
      }
    }

    for (const track of stranded) {
      if (!rescued.has(track)) track.missing += 1;
    }

    // Only confident leftovers start a new track; starting one from a weak box
    // is how spurious tracks are born.
    for (const index of first.unmatchedDetections) {
      const detection = high[index];
      if (detection === undefined) continue;
      const className = classNames[detection.classId];
      if (className === undefined) continue;
      this.open(detection, className, frame, ts);
    }

    const stillAlive: Track[] = [];
    for (const track of this.active) {
      if (track.missing > this.options.maxAge) this.finished.push(track);
      else stillAlive.push(track);
    }
    this.active = stillAlive;
  }

  /** Every track worth keeping, closed and open alike. */
  results(): Track[] {
    return [...this.finished, ...this.active].filter(
      (track) => track.points.length >= this.options.minLength,
    );
  }
}

