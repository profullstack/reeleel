import { describe, expect, it } from 'vitest';

import { ReelEelError } from './errors.js';
import { formatTimecode, parseFrameRate, parseProbeOutput, parseTimecode } from './ffmpeg.js';

const FFPROBE_JSON = JSON.stringify({
  format: {
    format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
    duration: '2712.480000',
    size: '4183920640',
    bit_rate: '12340000',
  },
  streams: [
    {
      codec_type: 'video',
      codec_name: 'h264',
      width: 3840,
      height: 2160,
      avg_frame_rate: '30000/1001',
      side_data_list: [{ rotation: -90 }],
    },
    { codec_type: 'audio', codec_name: 'aac', channels: 2, sample_rate: '48000' },
  ],
});

describe('parseFrameRate', () => {
  it('handles rational frame rates', () => {
    expect(parseFrameRate('30000/1001')).toBeCloseTo(29.97, 2);
    expect(parseFrameRate('25/1')).toBe(25);
  });

  it('survives the degenerate values ffprobe emits for still images', () => {
    expect(parseFrameRate('0/0')).toBe(0);
    expect(parseFrameRate(undefined)).toBe(0);
    expect(parseFrameRate('garbage')).toBe(0);
  });
});

describe('parseProbeOutput', () => {
  it('extracts container, duration and stream details', () => {
    const result = parseProbeOutput('/tmp/game.mp4', FFPROBE_JSON);
    expect(result.durationSeconds).toBeCloseTo(2712.48);
    expect(result.sizeBytes).toBe(4183920640);
    expect(result.video?.width).toBe(3840);
    expect(result.video?.fps).toBeCloseTo(29.97, 2);
    expect(result.audio?.channels).toBe(2);
  });

  it('normalises negative rotation to 0..359 — phone footage depends on this', () => {
    expect(parseProbeOutput('/tmp/game.mp4', FFPROBE_JSON).video?.rotation).toBe(270);
  });

  it('reads the legacy rotate tag when there is no side data', () => {
    const legacy = JSON.stringify({
      format: { format_name: 'mp4', duration: '10', size: '1', bit_rate: '1' },
      streams: [{ codec_type: 'video', codec_name: 'h264', width: 640, height: 480, tags: { rotate: '90' } }],
    });
    expect(parseProbeOutput('/tmp/a.mp4', legacy).video?.rotation).toBe(90);
  });

  it('rejects a file with no usable streams', () => {
    const empty = JSON.stringify({ format: { format_name: 'mp4' }, streams: [] });
    expect(() => parseProbeOutput('/tmp/broken.mp4', empty)).toThrow(ReelEelError);
  });

  it('rejects unparseable output', () => {
    expect(() => parseProbeOutput('/tmp/x.mp4', 'not json')).toThrow(ReelEelError);
  });
});

describe('timecodes', () => {
  it('formats seconds as hh:mm:ss.mmm', () => {
    expect(formatTimecode(0)).toBe('00:00:00.000');
    expect(formatTimecode(3661.5)).toBe('01:01:01.500');
  });

  it('clamps nonsense to zero rather than emitting a broken timecode', () => {
    expect(formatTimecode(-5)).toBe('00:00:00.000');
    expect(formatTimecode(Number.NaN)).toBe('00:00:00.000');
  });

  it('parses the formats the CLI accepts', () => {
    expect(parseTimecode('90')).toBe(90);
    expect(parseTimecode('1:30')).toBe(90);
    expect(parseTimecode('1:02:03')).toBe(3723);
    expect(parseTimecode('90.5')).toBe(90.5);
  });

  it('returns NaN for input it cannot read', () => {
    expect(parseTimecode('')).toBeNaN();
    expect(parseTimecode('abc')).toBeNaN();
  });

  it('round-trips through format and parse', () => {
    expect(parseTimecode(formatTimecode(3723.25))).toBeCloseTo(3723.25, 3);
  });
});
