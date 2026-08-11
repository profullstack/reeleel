import { describe, expect, it } from 'vitest';

import { SUPPORTED_EXTENSIONS, isSupportedExtension } from './videos.js';

describe('isSupportedExtension', () => {
  it('accepts what phones and action cams produce', () => {
    for (const file of ['clip.mp4', 'IMG_4021.MOV', 'GX010042.mp4', 'VID_20260810.3gp']) {
      expect(isSupportedExtension(file), file).toBe(true);
    }
  });

  it('accepts AVCHD camcorder footage', () => {
    for (const file of ['00000.MTS', '00001.m2ts', 'clip.m2t', 'stream.ts']) {
      expect(isSupportedExtension(file), file).toBe(true);
    }
  });

  it('accepts the containers a browser or screen recorder writes', () => {
    for (const file of ['input.webm', 'capture.mkv', 'recording.ogv']) {
      expect(isSupportedExtension(file), file).toBe(true);
    }
  });

  it('accepts older camera, dashcam and broadcast containers', () => {
    for (const file of ['DSCN0001.AVI', 'movie.mpg', 'VTS_01_1.VOB', 'a.wmv', 'A001C001.MXF']) {
      expect(isSupportedExtension(file), file).toBe(true);
    }
  });

  it('is case insensitive', () => {
    expect(isSupportedExtension('GAME.MP4')).toBe(true);
    expect(isSupportedExtension('game.WebM')).toBe(true);
  });

  it('rejects things that are not footage', () => {
    for (const file of ['notes.txt', 'photo.jpg', 'audio.mp3', 'archive.zip', 'noextension']) {
      expect(isSupportedExtension(file), file).toBe(false);
    }
  });

  it('rejects camera raw formats ffmpeg cannot demux', () => {
    for (const file of ['A001.braw', 'B002.r3d', 'C003.ari']) {
      expect(isSupportedExtension(file), file).toBe(false);
    }
  });

  it('lists every extension lowercased and dot-prefixed', () => {
    for (const ext of SUPPORTED_EXTENSIONS) {
      expect(ext, ext).toBe(ext.toLowerCase());
      expect(ext.startsWith('.'), ext).toBe(true);
    }
    expect(new Set(SUPPORTED_EXTENSIONS).size).toBe(SUPPORTED_EXTENSIONS.length);
  });
});
