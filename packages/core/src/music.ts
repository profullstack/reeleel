import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { ReelEelError } from './errors.js';

/**
 * Generating the backing track, via Lyria.
 *
 * `renderReel` has always accepted a `musicPath`. The problem was never mixing
 * the bed — it was that a parent has no track they are allowed to use. Every
 * recognisable song is licensed, and a highlight reel with a chart record
 * under it is exactly the reel that gets muted or pulled when it is shared.
 * Generating the bed removes the question rather than answering it.
 *
 * On what leaves the machine, the same rule as `speak`, and an easier one to
 * keep: a music prompt describes a mood. It contains no athlete name, no team,
 * no footage, and nothing derived from the video. The presets below are the
 * only prompts this module will send, which is what makes that checkable
 * rather than merely intended.
 */

/** Vertex serves Lyria; the model name is overridable because it moves. */
export const DEFAULT_MUSIC_MODEL = 'lyria-002';
export const DEFAULT_MUSIC_LOCATION = 'us-central1';

/**
 * The moods a reel can have.
 *
 * A closed set on purpose. Free-text prompts would be the one place an
 * athlete's name could reach a third party from this module, and there is no
 * reason a backing track needs to know it.
 */
export const MUSIC_MOODS = {
  triumphant: 'An uplifting, triumphant instrumental with bright brass and a driving drum beat.',
  hopeful: 'A warm, hopeful instrumental with soft piano, light strings and gentle percussion.',
  determined:
    'A steady, determined instrumental with a persistent low pulse and building percussion.',
  playful: 'A light, playful instrumental with plucked strings and an easy, bouncing rhythm.',
  cinematic: 'A wide, cinematic instrumental with sustained strings and a slow, patient build.',
  calm: 'A calm, understated instrumental with soft pads and almost no percussion.',
} as const;

export type MusicMood = keyof typeof MUSIC_MOODS;

export const MUSIC_MOOD_NAMES = Object.keys(MUSIC_MOODS) as MusicMood[];

/** Nothing vocal: words under a reel compete with the commentary. */
const NEGATIVE_PROMPT = 'vocals, singing, lyrics, spoken word, sound effects, crowd noise';

export const isMusicMood = (value: unknown): value is MusicMood =>
  typeof value === 'string' && Object.prototype.hasOwnProperty.call(MUSIC_MOODS, value);

/**
 * Credentials for Lyria.
 *
 * Unlike ElevenLabs this needs a project and an OAuth token rather than a
 * simple key, so it is read as a pair and reported as missing together —
 * having one without the other is the same as having neither.
 */
export interface MusicCredentials {
  projectId: string;
  accessToken: string;
  location: string;
}

export const musicCredentials = (): MusicCredentials | null => {
  const projectId = process.env['GOOGLE_CLOUD_PROJECT']?.trim();
  const accessToken = process.env['GOOGLE_ACCESS_TOKEN']?.trim();
  if (
    projectId === undefined ||
    projectId.length === 0 ||
    accessToken === undefined ||
    accessToken.length === 0
  ) {
    return null;
  }

  const location = process.env['GOOGLE_CLOUD_LOCATION']?.trim();
  return {
    projectId,
    accessToken,
    location: location === undefined || location.length === 0 ? DEFAULT_MUSIC_LOCATION : location,
  };
};

export interface ComposeOptions {
  credentials: MusicCredentials;
  model?: string;
  /**
   * Fixes the track for a given mood. Two renders of the same reel should not
   * come back with different music unless the parent asked for that.
   */
  seed?: number;
  signal?: AbortSignal;
  /** Injectable so tests never call Vertex. */
  fetchImpl?: typeof fetch;
}

/**
 * Builds the prompt for a mood.
 *
 * Exported so a caller can show a parent exactly what will be sent before
 * anything leaves the machine.
 *
 * @param mood - One of the presets
 * @returns The full prompt text
 */
export const musicPrompt = (mood: MusicMood): string => MUSIC_MOODS[mood];

/**
 * Generates a backing track and returns its path.
 *
 * Cached by content, like `speak`: the same mood, model and seed produce the
 * same file name, so re-rendering a reel after trimming a clip does not
 * re-generate — or re-pay for — the bed.
 *
 * @param mood - The mood preset to generate
 * @param outputDir - Where to write the track
 * @param options - Credentials and generation settings
 * @returns Path to a wav file on disk
 */
export const compose = async (
  mood: MusicMood,
  outputDir: string,
  options: ComposeOptions,
): Promise<string> => {
  if (!isMusicMood(mood)) {
    throw new ReelEelError('UNSUPPORTED_OPERATION', `Unknown music mood "${String(mood)}".`, {
      hint: `Choose one of: ${MUSIC_MOOD_NAMES.join(', ')}.`,
    });
  }

  const model = options.model ?? DEFAULT_MUSIC_MODEL;
  const seed = options.seed ?? 0;

  mkdirSync(outputDir, { recursive: true });
  const stamp = await digest(`${model}:${mood}:${seed}`);
  const output = path.join(outputDir, `bed_${stamp}.wav`);
  if (existsSync(output)) return output;

  const { projectId, accessToken, location } = options.credentials;
  const url =
    `https://${location}-aiplatform.googleapis.com/v1/projects/${projectId}` +
    `/locations/${location}/publishers/google/models/${model}:predict`;

  const doFetch = options.fetchImpl ?? fetch;
  const response = await doFetch(url, {
    method: 'POST',
    headers: {
      // The token is never logged, never written to a job record, and never
      // returned in an error — the same rule the voice path follows.
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      instances: [{ prompt: musicPrompt(mood), negative_prompt: NEGATIVE_PROMPT, seed }],
      parameters: {},
    }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new ReelEelError('MUSIC_FAILED', `Music generation failed (${response.status}).`, {
      hint: detail.slice(0, 200) || undefined,
    });
  }

  const payload = (await response.json().catch(() => null)) as {
    predictions?: { bytesBase64Encoded?: string }[];
  } | null;

  const encoded = payload?.predictions?.[0]?.bytesBase64Encoded;
  if (encoded === undefined || encoded.length === 0) {
    throw new ReelEelError('MUSIC_FAILED', 'Music generation returned no audio.', {
      hint: 'Try a different mood, or render without music.',
    });
  }

  writeFileSync(output, Buffer.from(encoded, 'base64'));
  return output;
};

/**
 * Generates a bed if it can, and returns null if it cannot.
 *
 * A reel without music is a fine reel. Nothing about a missing key, a quota or
 * a network fault should stop a parent getting the video of their child, so
 * the failure is swallowed here and reported through `onSkip` instead of
 * propagating into the render.
 *
 * @param mood - The mood preset, or undefined for no music
 * @param outputDir - Where to write the track
 * @param options - Generation settings, credentials optional
 * @returns Path to a track, or null when there is none
 */
export const composeOrSkip = async (
  mood: MusicMood | undefined,
  outputDir: string,
  options: Omit<ComposeOptions, 'credentials'> & {
    credentials?: MusicCredentials | null;
    onSkip?: (reason: string) => void;
  } = {},
): Promise<string | null> => {
  if (mood === undefined) return null;

  const credentials = options.credentials ?? musicCredentials();
  if (credentials === null) {
    options.onSkip?.(
      'No Google Cloud credentials configured, rendering without a backing track.',
    );
    return null;
  }

  try {
    return await compose(mood, outputDir, { ...options, credentials });
  } catch (error) {
    options.onSkip?.(error instanceof Error ? error.message : 'Music generation failed.');
    return null;
  }
};

/** Stable short hash for cache file names. */
const digest = async (value: string): Promise<string> => {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
};
