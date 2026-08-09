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
  /** Terminology shown in the UI so a plugin can say "possession" vs "carry". */
  terms: Record<string, string>;
  classes: SportClass[];
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

const SOCCER: SportPlugin = {
  id: 'soccer',
  name: 'Soccer',
  version: '0.1.0',
  terms: {
    athlete: 'player',
    field: 'pitch',
    period: 'half',
    goal: 'goal',
  },
  classes: [
    { name: 'player', experimental: false, description: 'Outfield player' },
    { name: 'ball', experimental: false, description: 'Match ball' },
    { name: 'referee', experimental: false, description: 'Referee or assistant referee' },
    { name: 'goalkeeper', experimental: false, description: 'Goalkeeper' },
    { name: 'goal', experimental: false, description: 'Goal mouth' },
    { name: 'goal_post', experimental: true, description: 'Individual post or crossbar' },
    { name: 'field_line', experimental: true, description: 'Painted pitch line' },
    { name: 'corner_flag', experimental: true, description: 'Corner flag' },
    { name: 'scoreboard', experimental: true, description: 'Scoreboard in frame' },
    { name: 'bench', experimental: true, description: 'Team bench area' },
  ],
  tracker: {
    algorithm: 'bytetrack',
    maxAgeFrames: 30,
    minConfidence: 0.3,
    iouThreshold: 0.2,
  },
  moments: {
    // Observable signals, not claimed soccer semantics — the PRD is explicit
    // that MVP surfaces "Suggested Moments" rather than named events.
    rules: [
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
        label: 'Toward goal',
        weight: 0.2,
        description: 'Player or ball moving toward a goal',
      },
      {
        id: 'activity_near_goal',
        label: 'Activity near goal',
        weight: 0.15,
        description: 'Several tracks clustered near a goal',
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
    ],
    preRollSeconds: 4,
    postRollSeconds: 3,
    minDurationSeconds: 4,
    maxDurationSeconds: 25,
    minScore: 0.35,
  },
};

const BUILT_IN: Record<string, SportPlugin> = { soccer: SOCCER };

/**
 * Sports not yet implemented, but reserved so `reeleel sports list` can show the
 * roadmap instead of pretending they do not exist.
 */
export const PLANNED_SPORTS = ['basketball', 'baseball', 'hockey', 'lacrosse', 'volleyball'];

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
  return [...plugins.values()].sort((a, b) => a.id.localeCompare(b.id));
};

export const getSport = (id: string, options: SportRegistryOptions = {}): SportPlugin | null =>
  listSports(options).find((plugin) => plugin.id === id) ?? null;

export const isKnownSport = (id: string, options: SportRegistryOptions = {}): boolean =>
  getSport(id, options) !== null;

/** Non-experimental class names — what the MVP detector is expected to output. */
export const requiredClasses = (plugin: SportPlugin): string[] =>
  plugin.classes.filter((c) => !c.experimental).map((c) => c.name);

export const DEFAULT_SPORT = 'soccer';
