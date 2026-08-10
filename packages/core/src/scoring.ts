import type { MomentRule, SportPlugin } from '@reeleel/sports';

/**
 * Suggested-moment scoring. Deliberately built on *observable* signals — ball
 * proximity, acceleration, direction of travel — rather than claimed soccer
 * semantics. The PRD is explicit that MVP surfaces "Suggested Moments", not
 * "goals" or "assists", so nothing here pretends to classify events.
 *
 * Everything is a pure function over track samples, which keeps it testable
 * with synthetic data and independent of whichever detector produced the tracks.
 */

export interface TrackSample {
  ts: number;
  /** Bounding box in pixels, top-left origin. */
  x: number;
  y: number;
  w: number;
  h: number;
  confidence: number;
}

export interface TrackSeries {
  id: string;
  className: string;
  samples: TrackSample[];
}

export interface AudioEnergySample {
  ts: number;
  /** Normalized 0..1 energy. */
  value: number;
}

export interface ScoringInput {
  durationSeconds: number;
  frameWidth: number;
  frameHeight: number;
  /** Track the user bound to their athlete. Without it, only scene-wide signals fire. */
  focalTrackId: string | null;
  /**
   * Every track that is the same athlete.
   *
   * Tracking breaks a player into fragments whenever they are occluded or leave
   * frame — on real footage the longest single track covered 24 seconds of a
   * five-minute game, and the same child appeared in the picker as several
   * separate people. Binding one fragment gave scoring 8% of the athlete.
   * Supplying all of them stitches the athlete back together.
   */
  focalTrackIds?: string[];
  tracks: TrackSeries[];
  audioEnergy?: AudioEnergySample[];
  /** Analysis granularity. Smaller = finer moments, more compute. */
  windowSeconds?: number;
}

export interface WindowScore {
  ts: number;
  score: number;
  reasons: string[];
}

export interface ScoredMoment {
  start: number;
  end: number;
  score: number;
  reasons: string[];
}

interface Point {
  x: number;
  y: number;
}

const center = (sample: TrackSample): Point => ({
  x: sample.x + sample.w / 2,
  y: sample.y + sample.h / 2,
});

/**
 * Longest silence a straight line may be drawn through when following the
 * athlete, in seconds.
 *
 * Stitching an athlete's fragments together leaves a hole wherever they were off
 * screen, and a straight line through one of those holes is an invented
 * position — it would put a child on the court while they sat on the bench, and
 * score it. This applies only to the focal athlete: the virtual cameraman
 * legitimately interpolates a smooth path across sparse keyframes, so plain
 * `sampleAt` still bridges any distance by default.
 */
const MAX_FOCAL_GAP = 2;

/**
 * Linear interpolation between the two samples bracketing `ts`. Returns null
 * outside the track's lifetime rather than extrapolating — an off-screen player
 * should produce no signal, not a guessed one. `maxGap` additionally refuses to
 * bridge silences longer than itself.
 */
export const sampleAt = (
  series: TrackSeries,
  ts: number,
  maxGap = Number.POSITIVE_INFINITY,
): Point | null => {
  const samples = series.samples;
  if (samples.length === 0) return null;
  const first = samples[0];
  const last = samples[samples.length - 1];
  if (first === undefined || last === undefined) return null;
  if (ts < first.ts || ts > last.ts) return null;

  for (let i = 1; i < samples.length; i += 1) {
    const previous = samples[i - 1];
    const current = samples[i];
    if (previous === undefined || current === undefined) continue;
    if (ts <= current.ts) {
      const span = current.ts - previous.ts;
      if (span > maxGap) return null;
      if (span <= 0) return center(current);
      const t = (ts - previous.ts) / span;
      const a = center(previous);
      const b = center(current);
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    }
  }
  return center(last);
};

/** Pixels per second, estimated across a small symmetric window. */
export const velocityAt = (
  series: TrackSeries,
  ts: number,
  dt = 0.25,
  maxGap = Number.POSITIVE_INFINITY,
): Point | null => {
  const before = sampleAt(series, ts - dt, maxGap);
  const after = sampleAt(series, ts + dt, maxGap);
  if (before === null || after === null) return null;
  return { x: (after.x - before.x) / (dt * 2), y: (after.y - before.y) / (dt * 2) };
};

const distance = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y);

const magnitude = (p: Point): number => Math.hypot(p.x, p.y);

/** Cosine of the angle between two vectors; 1 = same direction. */
const cosineSimilarity = (a: Point, b: Point): number => {
  const denominator = magnitude(a) * magnitude(b);
  if (denominator === 0) return 0;
  return (a.x * b.x + a.y * b.y) / denominator;
};

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

const ruleWeights = (plugin: SportPlugin): Map<string, number> =>
  new Map(plugin.moments.rules.map((rule: MomentRule) => [rule.id, rule.weight]));

export interface SignalContext {
  input: ScoringInput;
  diagonal: number;
  focal: TrackSeries | null;
  /**
   * Every detected ball track, not one of them.
   *
   * This was `tracks.find(t => t.className === 'ball')` — the first ball in the
   * list and nothing else. A detector that sees the ball intermittently emits it
   * as many short tracks (56, in the run that prompted this), so the signals
   * carrying 0.45 of the total weight were reading a single arbitrary fragment
   * and scoring zero across the rest of the game.
   */
  balls: TrackSeries[];
  goals: TrackSeries[];
  others: TrackSeries[];
  /** Median scene speed, used as the baseline for the high-motion signal. */
  baselineSpeed: number;
}

const medianOf = (values: number[]): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? 0;
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
};

/**
 * One athlete out of however many fragments the tracker produced for them.
 *
 * Samples are merged in time order and de-duplicated, keeping the more confident
 * of any two observations at the same instant — fragments overlap when the
 * tracker re-acquires someone it had not yet given up on. The result behaves
 * like a single track everywhere else in this file, so nothing downstream needs
 * to know the athlete was ever in pieces.
 */
export const stitchFocal = (input: ScoringInput): TrackSeries | null => {
  const ids = input.focalTrackIds ?? (input.focalTrackId === null ? [] : [input.focalTrackId]);
  if (ids.length === 0) return null;

  const wanted = new Set(ids);
  const parts = input.tracks.filter((track) => wanted.has(track.id));
  const first = parts[0];
  if (first === undefined) return null;
  if (parts.length === 1) return first;

  const byTs = new Map<number, TrackSample>();
  for (const part of parts) {
    for (const sample of part.samples) {
      const existing = byTs.get(sample.ts);
      if (existing === undefined || sample.confidence > existing.confidence) {
        byTs.set(sample.ts, sample);
      }
    }
  }

  return {
    id: first.id,
    className: first.className,
    samples: [...byTs.values()].sort((a, b) => a.ts - b.ts),
  };
};

export const buildContext = (input: ScoringInput, targetClass: string | null = 'goal'): SignalContext => {
  const focal = stitchFocal(input);
  const balls = input.tracks.filter((track) => track.className === 'ball');
  // The scoring target is named by the sport, not assumed to be "goal":
  // basketball tracks a `hoop`, hockey a `net`, football an `end_zone`.
  const goals =
    targetClass === null ? [] : input.tracks.filter((track) => track.className === targetClass);
  const others = input.tracks.filter(
    (track) => track.className === 'player' || track.className === 'goalkeeper',
  );

  const step = input.windowSeconds ?? 1;
  const speeds: number[] = [];
  for (let ts = 0; ts <= input.durationSeconds; ts += step) {
    const frameSpeeds = others
      .map((track) => velocityAt(track, ts))
      .filter((v): v is Point => v !== null)
      .map(magnitude);
    if (frameSpeeds.length > 0) {
      speeds.push(frameSpeeds.reduce((sum, s) => sum + s, 0) / frameSpeeds.length);
    }
  }

  return {
    input,
    diagonal: Math.hypot(input.frameWidth, input.frameHeight),
    focal,
    balls,
    goals,
    others,
    baselineSpeed: medianOf(speeds),
  };
};

/** The athlete's position at `ts`, refusing to bridge an occlusion gap. */
const focalAt = (context: SignalContext, ts: number): Point | null =>
  context.focal === null ? null : sampleAt(context.focal, ts, MAX_FOCAL_GAP);

/** The athlete's velocity at `ts`, on the same terms. */
const focalVelocityAt = (context: SignalContext, ts: number): Point | null =>
  context.focal === null ? null : velocityAt(context.focal, ts, 0.25, MAX_FOCAL_GAP);

/**
 * The ball in play at `ts`, across every ball fragment the detector produced.
 *
 * Fragments overlap and contradict each other — a bounce, a hand, a spectator's
 * bag can all be "sports ball" for a few frames — so when several are live at
 * once the one nearest the focal player is the one that matters to the signals
 * that follow the athlete. With no focal player, any live fragment will do.
 */
export const ballAt = (
  context: SignalContext,
  ts: number,
): { track: TrackSeries; point: Point } | null => {
  const live = context.balls
    .map((track) => {
      const point = sampleAt(track, ts);
      return point === null ? null : { track, point };
    })
    .filter((entry): entry is { track: TrackSeries; point: Point } => entry !== null);

  const first = live[0];
  if (first === undefined) return null;

  const player = focalAt(context, ts);
  if (player === null) return first;
  return live.reduce((closest, entry) =>
    distance(entry.point, player) < distance(closest.point, player) ? entry : closest,
  );
};

/**
 * A signal's strength in [0,1], or null when it cannot be measured at all.
 *
 * The distinction matters more than it looks. "Measured, and nothing was
 * happening" is a zero that should pull the score down. "There is no hoop in
 * this footage, and no audio track" is not evidence of a dull moment — yet
 * dividing by its weight anyway charged every window for it. With the shipped
 * COCO model, which produces only players and a ball, that dead weight was
 * enough to hold a genuine possession below the threshold.
 */
type SignalFn = (context: SignalContext, ts: number) => number | null;

/**
 * Each signal returns 0..1 strength at a moment in time. Weights come from the
 * sport plugin, so a new sport can retune without touching this file.
 */
export const SIGNALS: Record<string, SignalFn> = {
  player_ball_proximity: (context, ts) => {
    if (context.focal === null || context.balls.length === 0) return null;
    const player = focalAt(context, ts);
    const ball = ballAt(context, ts);
    /**
     * No ball on screen right now is not evidence of a dull moment.
     *
     * Returning 0 here kept 0.45 of the weight in the denominator while
     * contributing nothing to the numerator. On real footage the detector saw
     * the ball for 10 seconds out of 300 — a basketball is about six pixels
     * across once a 1080p frame becomes a 416x416 tensor — so for 97% of the
     * game this was charging every window for evidence it could not have had.
     */
    if (player === null || ball === null) return null;
    // Full strength within 5% of the frame diagonal, fading out by 20%.
    const normalized = distance(player, ball.point) / context.diagonal;
    return clamp01(1 - (normalized - 0.05) / 0.15);
  },

  ball_approaching_player: (context, ts) => {
    if (context.focal === null || context.balls.length === 0) return null;
    const player = focalAt(context, ts);
    const ball = ballAt(context, ts);
    // Same reasoning as proximity: an unseen ball is unmeasured, not stationary.
    if (player === null || ball === null) return null;
    const ballVelocity = velocityAt(ball.track, ts);
    if (ballVelocity === null || magnitude(ballVelocity) < 1) return 0;
    const toPlayer = { x: player.x - ball.point.x, y: player.y - ball.point.y };
    return clamp01(cosineSimilarity(ballVelocity, toPlayer));
  },

  player_acceleration: (context, ts) => {
    if (context.focal === null) return null;
    const before = focalVelocityAt(context, ts - 0.5);
    const after = focalVelocityAt(context, ts + 0.5);
    /**
     * Off screen is unmeasured, not motionless.
     *
     * This returned 0, which is the same mistake ball proximity used to make and
     * costs more, because an athlete is absent from far more of a game than the
     * ball is. Bound to a ten-frame fragment of a five-minute game, this signal
     * and `toward_goal` between them kept 0.35 of the weight in the denominator
     * and contributed nothing to the numerator for 99.9% of the footage — and
     * reported themselves as "measurable" to the diagnosis, which then told the
     * user the threshold was reachable when it was arithmetically not.
     */
    if (before === null || after === null) return null;
    const delta = Math.abs(magnitude(after) - magnitude(before));
    // Treat a 10%-of-diagonal-per-second change as a full-strength burst.
    return clamp01(delta / (context.diagonal * 0.1));
  },

  toward_goal: (context, ts) => {
    if (context.focal === null || context.goals.length === 0) return null;
    const player = focalAt(context, ts);
    const velocity = focalVelocityAt(context, ts);
    // Absent athlete: unmeasurable. Present but stationary: a real zero.
    if (player === null || velocity === null) return null;
    if (magnitude(velocity) < 1) return 0;

    const goalPoints = context.goals
      .map((goal) => sampleAt(goal, ts))
      .filter((p): p is Point => p !== null);
    // No rim in frame at this instant is no evidence either way.
    if (goalPoints.length === 0) return null;

    const best = goalPoints.reduce((closest, point) =>
      distance(player, point) < distance(player, closest) ? point : closest,
    );
    const toGoal = { x: best.x - player.x, y: best.y - player.y };
    return clamp01(cosineSimilarity(velocity, toGoal));
  },

  activity_near_goal: (context, ts) => {
    if (context.goals.length === 0) return null;
    const goalPoints = context.goals
      .map((goal) => sampleAt(goal, ts))
      .filter((p): p is Point => p !== null);
    // The rim exists somewhere in the footage but is not in this frame; that is
    // not a quiet key, it is no measurement.
    if (goalPoints.length === 0) return null;

    const near = context.others.filter((track) => {
      const point = sampleAt(track, ts);
      if (point === null) return false;
      return goalPoints.some((goal) => distance(point, goal) < context.diagonal * 0.25);
    }).length;
    // Four or more bodies in the box reads as a scramble.
    return clamp01(near / 4);
  },

  high_motion: (context, ts) => {
    if (context.others.length === 0 || context.baselineSpeed <= 0) return null;
    const speeds = context.others
      .map((track) => velocityAt(track, ts))
      .filter((v): v is Point => v !== null)
      .map(magnitude);
    // Nobody on screen at all: unmeasured, rather than a still court.
    if (speeds.length === 0) return null;
    const mean = speeds.reduce((sum, s) => sum + s, 0) / speeds.length;
    return clamp01((mean / context.baselineSpeed - 1) / 1.5);
  },

  audio_spike: (context, ts) => {
    const samples = context.input.audioEnergy;
    if (samples === undefined || samples.length === 0) return null;
    const window = samples.filter((sample) => Math.abs(sample.ts - ts) <= 1);
    if (window.length === 0) return 0;
    return clamp01(Math.max(...window.map((sample) => sample.value)));
  },
};

export const scoreWindow = (
  context: SignalContext,
  plugin: SportPlugin,
  ts: number,
): WindowScore => {
  const weights = ruleWeights(plugin);
  const reasons: string[] = [];
  let total = 0;
  let weightSum = 0;

  let definedWeight = 0;

  for (const [id, signal] of Object.entries(SIGNALS)) {
    const weight = weights.get(id);
    if (weight === undefined || weight <= 0) continue;
    definedWeight += weight;

    const strength = signal(context, ts);
    // Unmeasurable: no hoop in frame, no audio track, no athlete identified.
    // It neither contributes nor counts against.
    if (strength === null) continue;

    weightSum += weight;
    if (strength <= 0) continue;
    total += strength * weight;
    // Only name a reason once it actually contributed something visible.
    if (strength >= 0.4) reasons.push(id);
  }

  /**
   * A floor under the denominator, so a single measurable signal cannot carry a
   * moment on its own. Without it, footage with no athlete identified would be
   * scored on scene motion alone — every scramble becomes a highlight — because
   * that one signal would be the whole of the denominator as well as the whole
   * of the numerator. Half the defined weight keeps "identify your athlete"
   * genuinely necessary while no longer charging a window for evidence that
   * could never have existed.
   */
  const floor = definedWeight * 0.5;

  return {
    ts,
    score: weightSum > 0 ? clamp01(total / Math.max(weightSum, floor)) : 0,
    reasons,
  };
};

/**
 * Why a run produced the moments it did — or, far more usefully, why it produced
 * none.
 *
 * "Tracks were found but none scored above the threshold" is not a diagnosis.
 * It is consistent with footage that was genuinely dull, with an athlete nobody
 * identified, and with a detector that never saw a ball — three problems whose
 * fixes have nothing in common. The number that separates them is the *ceiling*:
 * the best score reachable given which signals had data at all. When the ceiling
 * sits below the threshold, no footage however good could have cleared it, and
 * telling the user to try better footage is actively wrong advice.
 */
export interface ScoringDiagnosis {
  threshold: number;
  /** Best score any window actually reached. */
  bestScore: number;
  bestTs: number;
  /** Best score *reachable* given only the signals that had data. */
  ceiling: number;
  /** False when the threshold is unreachable no matter what happens on screen. */
  reachable: boolean;
  focalBound: boolean;
  /**
   * Seconds the focal athlete is actually on screen, and across how many
   * fragments.
   *
   * "Athlete identified: yes" was the whole of what a user was told, and it is
   * true of a binding to a ten-frame fragment of a five-minute game just as it
   * is of a binding that follows the child all afternoon. The first cannot
   * produce a moment and the second can, so the flag on its own sent people to
   * re-shoot footage that was never the problem.
   */
  focalSeconds: number;
  focalTrackCount: number;
  /** Length of the footage, so focal coverage can be read as a fraction. */
  durationSeconds: number;
  /** How many tracks of each class the detector produced. */
  tracksByClass: Record<string, number>;
  /** Longest single track, in seconds — short ones mean fragmented tracking. */
  longestTrackSeconds: number;
  /** Signals that had data somewhere in the footage. */
  measurable: string[];
  /** Signals that never had data, and the weight they no longer consume. */
  unmeasurable: string[];
}

/**
 * Seconds the stitched athlete is genuinely followable — the spans scoring can
 * read, not first-to-last.
 *
 * Gaps longer than `MAX_FOCAL_GAP` are exactly the ones `focalAt` refuses to
 * interpolate across, so counting them would promise coverage the signals
 * cannot use.
 */
const focalCoverageSeconds = (focal: TrackSeries | null): number => {
  if (focal === null) return 0;
  let covered = 0;
  for (let i = 1; i < focal.samples.length; i += 1) {
    const previous = focal.samples[i - 1];
    const current = focal.samples[i];
    if (previous === undefined || current === undefined) continue;
    const span = current.ts - previous.ts;
    if (span > 0 && span <= MAX_FOCAL_GAP) covered += span;
  }
  return covered;
};

export const explainScoring = (input: ScoringInput, plugin: SportPlugin): ScoringDiagnosis => {
  const step = input.windowSeconds ?? 1;
  const context = buildContext(input, plugin.targetClass);
  const weights = ruleWeights(plugin);

  const measurable = new Set<string>();
  let definedWeight = 0;
  for (const [id, signal] of Object.entries(SIGNALS)) {
    const weight = weights.get(id);
    if (weight === undefined || weight <= 0) continue;
    definedWeight += weight;
    // A signal counts as measurable if it had data anywhere, not everywhere: a
    // ball visible for ten seconds of a game is still a ball.
    for (let ts = 0; ts <= input.durationSeconds; ts += step) {
      if (signal(context, ts) !== null) {
        measurable.add(id);
        break;
      }
    }
  }

  const measurableWeight = [...measurable].reduce((sum, id) => sum + (weights.get(id) ?? 0), 0);
  const floor = definedWeight * 0.5;
  const ceiling = measurableWeight > 0 ? clamp01(measurableWeight / Math.max(measurableWeight, floor)) : 0;

  let best: WindowScore = { ts: 0, score: 0, reasons: [] };
  if (step > 0 && input.durationSeconds > 0) {
    for (let ts = 0; ts <= input.durationSeconds; ts += step) {
      const window = scoreWindow(context, plugin, ts);
      if (window.score > best.score) best = window;
    }
  }

  const tracksByClass: Record<string, number> = {};
  let longestTrackSeconds = 0;
  for (const track of input.tracks) {
    tracksByClass[track.className] = (tracksByClass[track.className] ?? 0) + 1;
    const first = track.samples[0];
    const last = track.samples[track.samples.length - 1];
    if (first !== undefined && last !== undefined) {
      longestTrackSeconds = Math.max(longestTrackSeconds, last.ts - first.ts);
    }
  }

  return {
    threshold: plugin.moments.minScore,
    bestScore: best.score,
    bestTs: best.ts,
    ceiling,
    reachable: ceiling >= plugin.moments.minScore,
    focalBound: context.focal !== null,
    focalSeconds: focalCoverageSeconds(context.focal),
    focalTrackCount:
      input.focalTrackIds?.length ?? (input.focalTrackId === null ? 0 : 1),
    durationSeconds: input.durationSeconds,
    tracksByClass,
    longestTrackSeconds,
    measurable: [...measurable],
    unmeasurable: Object.keys(SIGNALS).filter(
      (id) => !measurable.has(id) && (weights.get(id) ?? 0) > 0,
    ),
  };
};

/**
 * Scores every window, then merges runs above `minScore` into moments, applying
 * the sport's pre/post roll and duration clamps.
 */
export const computeMoments = (input: ScoringInput, plugin: SportPlugin): ScoredMoment[] => {
  const step = input.windowSeconds ?? 1;
  if (step <= 0 || input.durationSeconds <= 0) return [];

  const context = buildContext(input, plugin.targetClass);
  const windows: WindowScore[] = [];
  for (let ts = 0; ts <= input.durationSeconds; ts += step) {
    windows.push(scoreWindow(context, plugin, ts));
  }

  const { minScore, preRollSeconds, postRollSeconds, minDurationSeconds, maxDurationSeconds } =
    plugin.moments;

  const moments: ScoredMoment[] = [];
  let run: WindowScore[] = [];

  const flush = (): void => {
    if (run.length === 0) return;
    const firstWindow = run[0];
    const lastWindow = run[run.length - 1];
    if (firstWindow === undefined || lastWindow === undefined) {
      run = [];
      return;
    }

    const peak = run.reduce((best, w) => (w.score > best.score ? w : best), firstWindow);
    const start = Math.max(0, firstWindow.ts - preRollSeconds);
    let end = Math.min(input.durationSeconds, lastWindow.ts + postRollSeconds);

    if (end - start < minDurationSeconds) {
      end = Math.min(input.durationSeconds, start + minDurationSeconds);
    }
    if (end - start > maxDurationSeconds) {
      // Keep the peak centred when we have to trim a long run.
      const half = maxDurationSeconds / 2;
      const trimmedStart = Math.max(0, Math.min(peak.ts - half, input.durationSeconds - maxDurationSeconds));
      moments.push({
        start: trimmedStart,
        end: Math.min(input.durationSeconds, trimmedStart + maxDurationSeconds),
        score: peak.score,
        reasons: [...new Set(run.flatMap((w) => w.reasons))],
      });
      run = [];
      return;
    }

    moments.push({
      start,
      end,
      score: peak.score,
      reasons: [...new Set(run.flatMap((w) => w.reasons))],
    });
    run = [];
  };

  for (const window of windows) {
    if (window.score >= minScore) {
      run.push(window);
    } else {
      flush();
    }
  }
  flush();

  return mergeOverlapping(moments);
};

/** Pre/post roll frequently makes neighbouring moments overlap; fuse those. */
export const mergeOverlapping = (moments: ScoredMoment[]): ScoredMoment[] => {
  const sorted = [...moments].sort((a, b) => a.start - b.start);
  const merged: ScoredMoment[] = [];

  for (const moment of sorted) {
    const previous = merged[merged.length - 1];
    if (previous !== undefined && moment.start <= previous.end) {
      previous.end = Math.max(previous.end, moment.end);
      previous.score = Math.max(previous.score, moment.score);
      previous.reasons = [...new Set([...previous.reasons, ...moment.reasons])];
    } else {
      merged.push({ ...moment });
    }
  }
  return merged;
};
