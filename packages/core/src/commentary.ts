import Anthropic from '@anthropic-ai/sdk';

import type { Clip, SuggestedMoment } from './types.js';

/**
 * What the announcer says over each clip.
 *
 * Two sources, in order of quality. A per-moment title the parent typed — "Sam
 * steals it at half court" — is the only thing in the system that knows what
 * actually happened; the detector knows a ball was near a player and nothing
 * else. So the title leads, and everything else is context around it.
 *
 * Without a title there is still a script, because a reel that silently drops
 * commentary on three of four clips is worse than one that says something
 * plain. The template is deliberately modest: it states the time and, when the
 * scoring signals support it, that the athlete was on the ball. It never
 * invents a shot, a steal, or a score, because nothing here can know that.
 */

export interface CommentaryLine {
  clipId: string;
  /** Seconds into the reel where this line should start. */
  startSeconds: number;
  text: string;
  /** True when a human wrote the title this came from. */
  fromTitle: boolean;
}

export interface CommentaryContext {
  athleteName: string | null;
  sport: string;
  /** Project name, used as the reel's title in the opening line. */
  projectName: string;
}

const clockOf = (seconds: number): string => {
  const total = Math.max(0, Math.round(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
};

/**
 * The fallback line for one clip.
 *
 * Says only what the system actually knows. `player_ball_proximity` means the
 * ball was near the athlete — that is a possession, not a basket, and the
 * wording keeps that distinction.
 */
export const templateLine = (
  moment: SuggestedMoment | undefined,
  context: CommentaryContext,
  index: number,
): string => {
  const who = context.athleteName ?? 'our player';
  if (moment?.title !== null && moment?.title !== undefined && moment.title.trim().length > 0) {
    return moment.title.trim();
  }

  const reasons = moment?.reasons ?? [];
  const onTheBall = reasons.includes('player_ball_proximity');
  const burst = reasons.includes('player_acceleration');
  const at = moment === undefined ? '' : ` at ${clockOf(moment.start)}`;

  if (onTheBall && burst) return `${who} on the ball and moving${at}.`;
  if (onTheBall) return `${who} gets on the ball${at}.`;
  if (burst) return `${who} makes a burst${at}.`;
  return `Play ${index + 1}${at}.`;
};

/** The whole reel as template lines, used when no AI key is configured. */
export const templateScript = (
  clips: Clip[],
  moments: SuggestedMoment[],
  context: CommentaryContext,
): CommentaryLine[] => {
  const byId = new Map(moments.map((moment) => [moment.id, moment]));
  let offset = 0;
  return clips.map((clip, index) => {
    const moment = clip.momentId === null ? undefined : byId.get(clip.momentId);
    const line: CommentaryLine = {
      clipId: clip.id,
      // Just after the clip starts, so the fade-in is not talked over.
      startSeconds: offset + 0.4,
      text: templateLine(moment, context, index),
      fromTitle:
        moment?.title !== null && moment?.title !== undefined && moment.title.trim().length > 0,
    };
    offset += clip.end - clip.start;
    return line;
  });
};

/** Shape the model must return, so nothing has to be parsed out of prose. */
const SCRIPT_SCHEMA = {
  type: 'object',
  properties: {
    lines: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          clipId: { type: 'string' },
          text: { type: 'string' },
        },
        required: ['clipId', 'text'],
        additionalProperties: false,
      },
    },
  },
  required: ['lines'],
  additionalProperties: false,
} as const;

const SYSTEM = `You write the play-by-play for a youth sports highlight reel that a parent will watch.

You are given one entry per clip. Write one line of commentary for each.

What you may say is strictly limited by what the entries tell you:

- If an entry has a title, the parent wrote it and it is the truth about that clip. Build the line around it.
- If an entry has no title, you know only the timestamp and which scoring signals fired. "player_ball_proximity" means the ball was near the athlete. "player_acceleration" means they changed speed. Nothing tells you whether a shot went in, who scored, or what the score is.

Never invent a basket, a steal, an assist, a score, a result, or an opponent's name. Inventing a moment that did not happen is the one unrecoverable failure here — the parent was at the game and will know.

Keep each line to at most about twelve words: it is spoken aloud over a clip a few seconds long, and it must finish before the clip does. Sound like a warm local announcer who knows the kid's name, not a network broadcast. Do not number the clips or say "clip one". Do not narrate the timestamps back.`;

export interface ScriptOptions {
  apiKey: string;
  /** Called with a one-line note about what happened, for the job log. */
  onProgress?: (message: string) => void;
}

/**
 * Commentary for the whole reel in one request.
 *
 * One call rather than one per clip: the lines then read as a single broadcast
 * that does not repeat itself, and it is a fraction of the cost. The system
 * prompt is cached because it is identical on every reel.
 *
 * Falls back to the template on any failure. An announcer is a nice-to-have and
 * must never be the reason a reel does not render.
 */
export const aiScript = async (
  clips: Clip[],
  moments: SuggestedMoment[],
  context: CommentaryContext,
  options: ScriptOptions,
): Promise<CommentaryLine[]> => {
  const fallback = templateScript(clips, moments, context);
  if (clips.length === 0) return fallback;

  const byId = new Map(moments.map((moment) => [moment.id, moment]));
  const entries = clips.map((clip, index) => {
    const moment = clip.momentId === null ? undefined : byId.get(clip.momentId);
    return {
      clipId: clip.id,
      order: index + 1,
      seconds: Number((clip.end - clip.start).toFixed(1)),
      title: clip.title ?? moment?.title ?? null,
      signals: moment?.reasons ?? [],
      gameClock: moment === undefined ? null : clockOf(moment.start),
    };
  });

  const client = new Anthropic({ apiKey: options.apiKey });

  try {
    const response = await client.messages.create({
      model: 'claude-opus-5',
      max_tokens: 2000,
      // Short, well-specified writing: the cheapest setting is the right one.
      output_config: {
        effort: 'low',
        format: { type: 'json_schema', schema: SCRIPT_SCHEMA },
      },
      system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
      messages: [
        {
          role: 'user',
          content: JSON.stringify({
            athlete: context.athleteName,
            sport: context.sport,
            reel: context.projectName,
            clips: entries,
          }),
        },
      ],
    });

    if (response.stop_reason === 'refusal') {
      options.onProgress?.('announcer: the model declined to write this script; using templates');
      return fallback;
    }

    const block = response.content.find((entry) => entry.type === 'text');
    if (block === undefined || block.type !== 'text') return fallback;

    const parsed = JSON.parse(block.text) as { lines?: { clipId: string; text: string }[] };
    const written = new Map((parsed.lines ?? []).map((line) => [line.clipId, line.text]));

    // Keep the template's timing; take only the words from the model. A missing
    // or empty line falls back per clip rather than failing the whole script.
    return fallback.map((line) => {
      const text = written.get(line.clipId)?.trim();
      return text === undefined || text.length === 0 ? line : { ...line, text };
    });
  } catch (error) {
    const reason = error instanceof Anthropic.APIError ? `${error.status} ${error.message}` : String(error);
    options.onProgress?.(`announcer: script generation failed (${reason}); using templates`);
    return fallback;
  }
};
