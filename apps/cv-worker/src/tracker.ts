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
}

export const DEFAULT_TRACKER_OPTIONS: TrackerOptions = {
  highThreshold: 0.5,
  lowThreshold: 0.1,
  iouThreshold: 0.2,
  maxAge: 30,
  minLength: 3,
  classHighThreshold: {},
  classBuffer: {},
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
): { matches: Pair[]; unmatchedTracks: number[]; unmatchedDetections: number[] } => {
  const candidates: Pair[] = [];

  tracks.forEach((track, trackIndex) => {
    const buffer = bufferFor(track);
    const predicted = inflate(predict(track), buffer);
    detections.forEach((detection, detectionIndex) => {
      if (detection.classId !== track.classId) return;
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
    this.active.push({
      id: this.nextId++,
      classId: detection.classId,
      className,
      points: [{ frame, ts, ...box(detection), confidence: detection.score }],
      missing: 0,
      confidence: detection.score,
      velocity: { x: 0, y: 0 },
      lastBox: box(detection),
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

    const usable = detections.filter((d) => d.score >= this.options.lowThreshold);
    const high = usable.filter((d) => d.score >= barFor(d));
    const low = usable.filter((d) => d.score < barFor(d));

    // Pass 1: confident detections against every live track.
    const first = associate(this.active, high, this.options.iouThreshold, bufferFor);
    for (const match of first.matches) {
      const track = this.active[match.trackIndex];
      const detection = high[match.detectionIndex];
      if (track !== undefined && detection !== undefined) this.extend(track, detection, frame, ts);
    }

    // Pass 2: the BYTE step — try the leftovers against tracks that missed out,
    // with a looser bar, so an occluded player is rescued rather than lost.
    const stranded = first.unmatchedTracks.map((i) => this.active[i]).filter((t): t is Track => t !== undefined);
    const second = associate(stranded, low, this.options.iouThreshold * 0.75, bufferFor);
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

