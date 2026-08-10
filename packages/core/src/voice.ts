import { createWriteStream, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { ReelEelError } from './errors.js';

/**
 * Turning commentary into speech, via ElevenLabs.
 *
 * The key is read from the environment and never logged, never written to a
 * job record, and never returned in an error — a failed synthesis reports the
 * status code and the service's message, both of which are safe.
 *
 * Text leaves the machine. That is unavoidable for hosted TTS and worth being
 * explicit about: the commentary lines go to a third party, so they are the
 * only thing sent — never the footage, never the athlete's other details.
 */

/** A default ElevenLabs voice; overridable per render. */
export const DEFAULT_VOICE_ID = '21m00Tcm4TlvDq8ikWAM';

export const voiceApiKey = (): string | null => {
  const key = process.env['ELEVENLABS_API_KEY'];
  return key === undefined || key.trim().length === 0 ? null : key.trim();
};

export interface SpeakOptions {
  apiKey: string;
  voiceId?: string;
  /** ElevenLabs model. Turbo is the cheap, low-latency one. */
  modelId?: string;
  signal?: AbortSignal;
}

/**
 * Synthesises one line to an mp3 on disk, returning its path.
 *
 * Cached by content: the same words in the same voice produce the same file
 * name, so re-rendering a reel after changing one clip does not re-synthesise —
 * or re-pay for — the lines that did not change.
 */
export const speak = async (
  text: string,
  outputDir: string,
  options: SpeakOptions,
): Promise<string> => {
  const voiceId = options.voiceId ?? DEFAULT_VOICE_ID;
  const modelId = options.modelId ?? 'eleven_turbo_v2_5';

  mkdirSync(outputDir, { recursive: true });
  const stamp = await digest(`${voiceId}:${modelId}:${text}`);
  const output = path.join(outputDir, `vo_${stamp}.mp3`);
  if (existsSync(output)) return output;

  const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
    method: 'POST',
    headers: {
      'xi-api-key': options.apiKey,
      'content-type': 'application/json',
      accept: 'audio/mpeg',
    },
    body: JSON.stringify({
      text,
      model_id: modelId,
      voice_settings: { stability: 0.4, similarity_boost: 0.75 },
    }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });

  if (!response.ok || response.body === null) {
    // The service's own message, never the key.
    const detail = await response.text().catch(() => '');
    throw new ReelEelError('VOICE_FAILED', `Voice synthesis failed (${response.status}).`, {
      hint: detail.slice(0, 200) || undefined,
    });
  }

  await pipeline(Readable.fromWeb(response.body as never), createWriteStream(output));
  return output;
};

/** Stable short hash for cache file names. */
const digest = async (value: string): Promise<string> => {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
};
