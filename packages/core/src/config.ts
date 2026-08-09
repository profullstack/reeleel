import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import { invalidInput } from './errors.js';
import { configFilePath, configHome } from './layout.js';
import { ASPECT_RATIOS, PRESETS } from './types.js';
import type { AspectRatio, Preset } from './types.js';

export interface ReelEelConfig {
  ffmpeg: {
    ffmpeg: string | null;
    ffprobe: string | null;
  };
  analysis: {
    preset: Preset;
    /** `auto` picks the best available runtime; CPU always works. */
    backend: 'auto' | 'cpu' | 'cuda' | 'rocm' | 'coreml' | 'directml';
    /** 0 = let the runtime decide. */
    threads: number;
    sampleEveryNthFrame: number;
  };
  projects: {
    /** Where `project create` puts new projects when no path is given. */
    dir: string;
    /** Copy source media into the project instead of referencing in place. */
    copySource: boolean;
  };
  export: {
    aspect: AspectRatio;
    fps: number;
    quality: 'low' | 'medium' | 'high';
    watermark: boolean;
  };
  privacy: {
    /** Off by default and stays off unless explicitly enabled. */
    telemetry: boolean;
    stripMetadataOnExport: boolean;
  };
}

export const defaultConfig = (): ReelEelConfig => ({
  ffmpeg: { ffmpeg: null, ffprobe: null },
  analysis: { preset: 'balanced', backend: 'auto', threads: 0, sampleEveryNthFrame: 2 },
  projects: { dir: path.join(homedir(), 'ReelEel'), copySource: false },
  export: { aspect: '16:9', fps: 30, quality: 'high', watermark: false },
  privacy: { telemetry: false, stripMetadataOnExport: true },
});

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

const isPlainObject = (value: unknown): value is Record<string, Json> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Shallow-per-section merge: unknown keys in the file are dropped, not merged. */
const mergeConfig = (base: ReelEelConfig, stored: unknown): ReelEelConfig => {
  if (!isPlainObject(stored)) return base;
  const merged = structuredClone(base) as unknown as Record<string, Record<string, Json>>;
  for (const [section, values] of Object.entries(stored)) {
    if (!(section in merged) || !isPlainObject(values)) continue;
    const target = merged[section];
    if (target === undefined) continue;
    for (const [key, value] of Object.entries(values)) {
      if (key in target) target[key] = value;
    }
  }
  return merged as unknown as ReelEelConfig;
};

export const loadConfig = (): ReelEelConfig => {
  const file = configFilePath();
  if (!existsSync(file)) return defaultConfig();
  try {
    return mergeConfig(defaultConfig(), JSON.parse(readFileSync(file, 'utf8')) as unknown);
  } catch {
    // A hand-edited, broken config should not brick the app.
    return defaultConfig();
  }
};

export const saveConfig = (config: ReelEelConfig): void => {
  mkdirSync(configHome(), { recursive: true });
  writeFileSync(configFilePath(), `${JSON.stringify(config, null, 2)}\n`, 'utf8');
};

/** Flattened `section.key` view, which is what `config list` prints. */
export const flattenConfig = (config: ReelEelConfig): Record<string, Json> => {
  const flat: Record<string, Json> = {};
  for (const [section, values] of Object.entries(config as unknown as Record<string, Json>)) {
    if (isPlainObject(values)) {
      for (const [key, value] of Object.entries(values)) flat[`${section}.${key}`] = value;
    } else {
      flat[section] = values;
    }
  }
  return flat;
};

const ENUMS: Record<string, readonly string[]> = {
  'analysis.preset': PRESETS,
  'analysis.backend': ['auto', 'cpu', 'cuda', 'rocm', 'coreml', 'directml'],
  'export.aspect': ASPECT_RATIOS,
  'export.quality': ['low', 'medium', 'high'],
};

/** Coerces a CLI string into the type the existing value already has. */
const coerce = (key: string, raw: string, current: Json): Json => {
  const allowed = ENUMS[key];
  if (allowed !== undefined) {
    if (!allowed.includes(raw)) {
      throw invalidInput(
        `"${raw}" is not a valid value for ${key}.`,
        `Valid values: ${allowed.join(', ')}`,
      );
    }
    return raw;
  }
  if (typeof current === 'boolean') {
    if (['true', '1', 'yes', 'on'].includes(raw.toLowerCase())) return true;
    if (['false', '0', 'no', 'off'].includes(raw.toLowerCase())) return false;
    throw invalidInput(`${key} expects a boolean, got "${raw}".`);
  }
  if (typeof current === 'number') {
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) throw invalidInput(`${key} expects a number, got "${raw}".`);
    return parsed;
  }
  return raw;
};

export const getConfigValue = (config: ReelEelConfig, key: string): Json => {
  const flat = flattenConfig(config);
  if (!(key in flat)) {
    throw invalidInput(
      `Unknown config key "${key}".`,
      `Run \`reeleel config list\` to see every key.`,
    );
  }
  return flat[key] as Json;
};

export const setConfigValue = (config: ReelEelConfig, key: string, raw: string): ReelEelConfig => {
  const [section, field] = key.split('.');
  const flat = flattenConfig(config);
  if (section === undefined || field === undefined || !(key in flat)) {
    throw invalidInput(
      `Unknown config key "${key}".`,
      `Run \`reeleel config list\` to see every key.`,
    );
  }
  const next = structuredClone(config) as unknown as Record<string, Record<string, Json>>;
  const target = next[section];
  if (target === undefined) throw invalidInput(`Unknown config section "${section}".`);
  target[field] = coerce(key, raw, flat[key] as Json);
  return next as unknown as ReelEelConfig;
};

/** Resets one key back to its shipped default. */
export const unsetConfigValue = (config: ReelEelConfig, key: string): ReelEelConfig => {
  const [section, field] = key.split('.');
  const defaults = flattenConfig(defaultConfig());
  if (section === undefined || field === undefined || !(key in defaults)) {
    throw invalidInput(
      `Unknown config key "${key}".`,
      `Run \`reeleel config list\` to see every key.`,
    );
  }
  const next = structuredClone(config) as unknown as Record<string, Record<string, Json>>;
  const target = next[section];
  if (target === undefined) throw invalidInput(`Unknown config section "${section}".`);
  target[field] = defaults[key] as Json;
  return next as unknown as ReelEelConfig;
};
