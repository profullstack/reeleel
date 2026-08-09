import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

/** A detectable object class. `experimental` classes are excluded from MVP scoring. */
export interface SportClass {
  name: string;
  experimental: boolean;
  description: string;
}

export interface MomentRule {
  id: string;
  label: string;
  /** Contribution to the moment score in [0,1]; weights need not sum to 1. */
  weight: number;
  description: string;
}

export interface SportPlugin {
  id: string;
  name: string;
  version: string;
  /** Terminology shown in the UI, so a plugin can say "basket" rather than "goal". */
  terms: Record<string, string>;
  classes: SportClass[];
  /**
   * The class name that represents the scoring target, when the sport has a
   * detectable one. Scoring used to look for `goal` regardless of sport, so
   * basketball's `hoop` was invisible to it — the target signals stayed dark
   * even for a model that could see the rim.
   */
  targetClass: string | null;
  tracker: {
    algorithm: string;
    maxAgeFrames: number;
    minConfidence: number;
    iouThreshold: number;
  };
  moments: {
    rules: MomentRule[];
    /** Seconds of footage kept before/after the triggering window. */
    preRollSeconds: number;
    postRollSeconds: number;
    minDurationSeconds: number;
    maxDurationSeconds: number;
    /** Moments scoring below this are not surfaced at all. */
    minScore: number;
  };
}

const VERSION = '0.1.0';

/**
 * Every sport shares the same observable signals — the scorer works on ball
 * proximity, acceleration and direction of travel, not on rules knowledge. What
 * differs per sport is the *target* a player moves toward and how long a play
 * lasts, so those are the only things a definition overrides.
 */
const baseRules = (target: string): MomentRule[] => [
  {
    id: 'player_ball_proximity',
    label: 'Ball near player',
    weight: 0.3,
    description: 'Focal player is close to the ball',
  },
  {
    id: 'ball_approaching_player',
    label: 'Ball approaching',
    weight: 0.15,
    description: 'Ball velocity points at the focal player',
  },
  {
    id: 'player_acceleration',
    label: 'Player burst',
    weight: 0.15,
    description: 'Sharp change in focal player speed',
  },
  {
    id: 'toward_goal',
    label: `Toward ${target}`,
    weight: 0.2,
    description: `Player or ball moving toward a ${target}`,
  },
  {
    id: 'activity_near_goal',
    label: `Activity near ${target}`,
    weight: 0.15,
    description: `Several tracks clustered near a ${target}`,
  },
  {
    id: 'high_motion',
    label: 'High motion',
    weight: 0.1,
    description: 'Sudden increase in overall scene motion',
  },
  {
    id: 'audio_spike',
    label: 'Crowd reaction',
    weight: 0.1,
    description: 'Audio energy spike (optional signal)',
  },
  {
    id: 'user_marker',
    label: 'Marked by you',
    weight: 1,
    description: 'Manually marked on the timeline',
  },
];

interface SportSpec {
  id: string;
  name: string;
  /** What players move toward: goal, basket, net, end zone… */
  target: string;
  /**
   * The tracked class that *is* the scoring target, when it is not simply the
   * slug of `target`. Basketball aims at the "basket" but the thing a detector
   * sees is the "hoop"; scoring needs the class name, not the noun.
   */
  targetClass?: string;
  terms: Record<string, string>;
  /** Non-experimental classes beyond the universal `player`. */
  core: [string, string][];
  experimental?: [string, string][];
  /** Typical play length, which sets the clip window. */
  play: { pre: number; post: number; min: number; max: number };
  tracker?: Partial<SportPlugin['tracker']>;
  minScore?: number;
}

const SPECS: SportSpec[] = [
  {
    id: 'soccer',
    name: 'Soccer',
    target: 'goal',
    terms: { athlete: 'player', field: 'pitch', period: 'half', target: 'goal' },
    core: [
      ['ball', 'Match ball'],
      ['referee', 'Referee or assistant referee'],
      ['goalkeeper', 'Goalkeeper'],
      ['goal', 'Goal mouth'],
    ],
    experimental: [
      ['goal_post', 'Individual post or crossbar'],
      ['field_line', 'Painted pitch line'],
      ['corner_flag', 'Corner flag'],
      ['scoreboard', 'Scoreboard in frame'],
      ['bench', 'Team bench area'],
    ],
    play: { pre: 4, post: 3, min: 4, max: 25 },
  },
  {
    id: 'basketball',
    name: 'Basketball',
    target: 'basket',
    targetClass: 'hoop',
    terms: { athlete: 'player', field: 'court', period: 'quarter', target: 'basket' },
    core: [
      ['ball', 'Basketball'],
      ['referee', 'Official'],
      ['hoop', 'Rim and backboard'],
    ],
    experimental: [
      ['three_point_line', 'Three-point arc'],
      ['scoreboard', 'Scoreboard in frame'],
      ['bench', 'Team bench area'],
    ],
    // Possessions are short and the court is small, so plays are tighter.
    play: { pre: 3, post: 2, min: 3, max: 15 },
  },
  {
    id: 'baseball',
    name: 'Baseball',
    target: 'base',
    terms: { athlete: 'player', field: 'diamond', period: 'inning', target: 'base' },
    core: [
      ['ball', 'Baseball'],
      ['bat', 'Bat'],
      ['glove', 'Fielding glove'],
      ['umpire', 'Umpire'],
      ['base', 'Base or home plate'],
    ],
    experimental: [
      ['pitchers_mound', "Pitcher's mound"],
      ['scoreboard', 'Scoreboard in frame'],
    ],
    // A pitch, a swing and a run to first is a long, discrete event.
    play: { pre: 5, post: 5, min: 5, max: 30 },
  },
  {
    id: 'softball',
    name: 'Softball',
    target: 'base',
    terms: { athlete: 'player', field: 'diamond', period: 'inning', target: 'base' },
    core: [
      ['ball', 'Softball'],
      ['bat', 'Bat'],
      ['glove', 'Fielding glove'],
      ['umpire', 'Umpire'],
      ['base', 'Base or home plate'],
    ],
    experimental: [['scoreboard', 'Scoreboard in frame']],
    play: { pre: 5, post: 5, min: 5, max: 30 },
  },
  {
    id: 'hockey',
    name: 'Ice hockey',
    target: 'net',
    terms: { athlete: 'player', field: 'rink', period: 'period', target: 'net' },
    core: [
      ['puck', 'Puck'],
      ['referee', 'Official'],
      ['goalie', 'Goaltender'],
      ['net', 'Goal net'],
    ],
    experimental: [
      ['blue_line', 'Blue line'],
      ['scoreboard', 'Scoreboard in frame'],
    ],
    // Skating speed makes everything faster, and the puck is small and easily
    // lost, so the tracker gets a lower confidence floor.
    play: { pre: 4, post: 3, min: 4, max: 20 },
    tracker: { minConfidence: 0.25, maxAgeFrames: 40 },
  },
  {
    id: 'lacrosse',
    name: 'Lacrosse',
    target: 'goal',
    terms: { athlete: 'player', field: 'field', period: 'quarter', target: 'goal' },
    core: [
      ['ball', 'Lacrosse ball'],
      ['stick', 'Crosse'],
      ['referee', 'Official'],
      ['goalkeeper', 'Goalie'],
      ['goal', 'Goal mouth'],
    ],
    experimental: [['crease', 'Goal crease']],
    play: { pre: 4, post: 3, min: 4, max: 22 },
    tracker: { minConfidence: 0.25 },
  },
  {
    id: 'football',
    name: 'Football (American)',
    target: 'end zone',
    terms: { athlete: 'player', field: 'field', period: 'quarter', target: 'end zone' },
    core: [
      ['ball', 'Football'],
      ['referee', 'Official'],
      ['end_zone', 'End zone'],
    ],
    experimental: [
      ['yard_line', 'Yard line'],
      ['goal_post', 'Goal post'],
      ['scoreboard', 'Scoreboard in frame'],
    ],
    // Snap to whistle, with a huddle either side.
    play: { pre: 4, post: 4, min: 5, max: 25 },
  },
  {
    id: 'volleyball',
    name: 'Volleyball',
    target: 'net',
    terms: { athlete: 'player', field: 'court', period: 'set', target: 'net' },
    core: [
      ['ball', 'Volleyball'],
      ['referee', 'Official'],
      ['net', 'Net'],
    ],
    experimental: [['antenna', 'Net antenna']],
    // Rallies are short and self-contained.
    play: { pre: 3, post: 3, min: 4, max: 18 },
  },
];

/**
 * Most sports name their target the same way a detector would — soccer aims at
 * a "goal" and tracks a `goal`. Where the noun and the class differ, the spec
 * says so. Anything that resolves to a class the sport does not actually track
 * is null rather than a name nothing will ever match.
 */
const targetClassOf = (spec: SportSpec): string | null => {
  const candidate = spec.targetClass ?? spec.target.trim().toLowerCase().replace(/\s+/g, '_');
  const tracked = new Set([
    'player',
    ...spec.core.map(([name]) => name),
    ...(spec.experimental ?? []).map(([name]) => name),
  ]);
  return tracked.has(candidate) ? candidate : null;
};

const build = (spec: SportSpec): SportPlugin => ({
  id: spec.id,
  name: spec.name,
  version: VERSION,
  terms: spec.terms,
  classes: [
    { name: 'player', experimental: false, description: 'Player on the field of play' },
    ...spec.core.map(([name, description]) => ({ name, experimental: false, description })),
    ...(spec.experimental ?? []).map(([name, description]) => ({
      name,
      experimental: true,
      description,
    })),
  ],
  targetClass: targetClassOf(spec),
  tracker: {
    algorithm: 'bytetrack',
    maxAgeFrames: 30,
    minConfidence: 0.3,
    iouThreshold: 0.2,
    ...spec.tracker,
  },
  moments: {
    rules: baseRules(spec.target),
    preRollSeconds: spec.play.pre,
    postRollSeconds: spec.play.post,
    minDurationSeconds: spec.play.min,
    maxDurationSeconds: spec.play.max,
    minScore: spec.minScore ?? 0.35,
  },
});

const BUILT_IN: Record<string, SportPlugin> = Object.fromEntries(
  SPECS.map((spec) => [spec.id, build(spec)]),
);

/**
 * Sports with no definition yet. Kept so `reeleel sports list` can show the
 * roadmap instead of pretending they do not exist.
 */
export const PLANNED_SPORTS = ['rugby', 'field_hockey', 'water_polo', 'handball', 'tennis'];

const isSportPlugin = (value: unknown): value is SportPlugin => {
  if (typeof value !== 'object' || value === null) return false;
  const plugin = value as Partial<SportPlugin>;
  return (
    typeof plugin.id === 'string' &&
    typeof plugin.name === 'string' &&
    Array.isArray(plugin.classes) &&
    typeof plugin.moments === 'object'
  );
};

/** Reads a user-installed plugin directory: `<dir>/plugin.json`. */
export const loadPluginFromDisk = (dir: string): SportPlugin | null => {
  const file = path.join(dir, 'plugin.json');
  if (!existsSync(file)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    return isSportPlugin(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

export interface SportRegistryOptions {
  /** Extra directory of user-installed sport plugins, each in its own subdir. */
  pluginDir?: string;
}

export const listSports = (options: SportRegistryOptions = {}): SportPlugin[] => {
  const plugins = new Map<string, SportPlugin>(Object.entries(BUILT_IN));
  const dir = options.pluginDir;
  if (dir !== undefined && existsSync(dir)) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const plugin = loadPluginFromDisk(path.join(dir, entry.name));
      // User plugins win, so a local override can fix a shipped definition.
      if (plugin !== null) plugins.set(plugin.id, plugin);
    }
  }
  return [...plugins.values()].sort((a, b) => a.name.localeCompare(b.name));
};

export const getSport = (id: string, options: SportRegistryOptions = {}): SportPlugin | null =>
  listSports(options).find((plugin) => plugin.id === id) ?? null;

export const isKnownSport = (id: string, options: SportRegistryOptions = {}): boolean =>
  getSport(id, options) !== null;

/** Non-experimental class names — what the MVP detector is expected to output. */
export const requiredClasses = (plugin: SportPlugin): string[] =>
  plugin.classes.filter((c) => !c.experimental).map((c) => c.name);

export const DEFAULT_SPORT = 'soccer';
