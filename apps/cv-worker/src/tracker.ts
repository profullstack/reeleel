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
}

export const DEFAULT_TRACKER_OPTIONS: TrackerOptions = {
  highThreshold: 0.5,
  lowThreshold: 0.1,
  iouThreshold: 0.2,
  maxAge: 30,
  minLength: 3,
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

/**
 * Greedy IoU association. Hungarian would be optimal, but greedy-by-IoU is
 * within noise for this many objects and is far easier to reason about when a
 * track goes wrong.
 */
const associate = (
  tracks: Track[],
  detections: Detection[],
  iouThreshold: number,
): { matches: Pair[]; unmatchedTracks: number[]; unmatchedDetections: number[] } => {
  const candidates: Pair[] = [];

  tracks.forEach((track, trackIndex) => {
    const predicted = predict(track);
    detections.forEach((detection, detectionIndex) => {
      if (detection.classId !== track.classId) return;
      const score = iou(predicted, detection);
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
    const usable = detections.filter((d) => d.score >= this.options.lowThreshold);
    const high = usable.filter((d) => d.score >= this.options.highThreshold);
    const low = usable.filter((d) => d.score < this.options.highThreshold);

    // Pass 1: confident detections against every live track.
    const first = associate(this.active, high, this.options.iouThreshold);
    for (const match of first.matches) {
      const track = this.active[match.trackIndex];
      const detection = high[match.detectionIndex];
      if (track !== undefined && detection !== undefined) this.extend(track, detection, frame, ts);
    }

    // Pass 2: the BYTE step — try the leftovers against tracks that missed out,
    // with a looser bar, so an occluded player is rescued rather than lost.
    const stranded = first.unmatchedTracks.map((i) => this.active[i]).filter((t): t is Track => t !== undefined);
    const second = associate(stranded, low, this.options.iouThreshold * 0.75);
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

const box = (detection: Detection): Box => ({
  x: detection.x,
  y: detection.y,
  w: detection.w,
  h: detection.h,
});
