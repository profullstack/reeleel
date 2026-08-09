import { describe, expect, it } from 'vitest';

import { assignSplit, parseFrameFileName, toCoco, toYolo } from './dataset.js';
import type { DatasetBundle } from './dataset.js';

const RATIOS = { train: 0.7, val: 0.2, test: 0.1 };

const bundle = (): DatasetBundle => ({
  name: 'Test',
  createdAt: '2026-01-01T00:00:00.000Z',
  classes: ['player', 'ball'],
  images: [
    {
      id: 1,
      fileName: 'vid_abc123_00000010.jpg',
      width: 1920,
      height: 1080,
      videoId: 'vid_abc123',
      frame: 10,
      split: 'train',
    },
  ],
  annotations: [
    {
      id: 'ann_1',
      videoId: 'vid_abc123',
      trackId: 'trk_1',
      frame: 10,
      ts: 0.4,
      className: 'player',
      x: 960,
      y: 540,
      w: 192,
      h: 216,
      occluded: false,
      outOfFrame: false,
    },
  ],
  splits: { train: 1, val: 0, test: 0 },
});

describe('assignSplit', () => {
  it('is deterministic for a given video and seed', () => {
    const first = assignSplit('vid_abc123', RATIOS, 'seed-1');
    for (let i = 0; i < 20; i += 1) {
      expect(assignSplit('vid_abc123', RATIOS, 'seed-1')).toBe(first);
    }
  });

  it('puts every frame of one video in the same split — no adjacent-frame leakage', () => {
    // The split is a function of the video id alone; frames cannot disagree.
    const split = assignSplit('vid_xyz', RATIOS, 'seed');
    expect(assignSplit('vid_xyz', RATIOS, 'seed')).toBe(split);
  });

  it('changes with the seed', () => {
    const ids = Array.from({ length: 40 }, (_, i) => `vid_${i}`);
    const a = ids.map((id) => assignSplit(id, RATIOS, 'seed-a'));
    const b = ids.map((id) => assignSplit(id, RATIOS, 'seed-b'));
    expect(a).not.toEqual(b);
  });

  it('roughly honours the requested proportions over many videos', () => {
    const ids = Array.from({ length: 600 }, (_, i) => `vid_${i}`);
    const counts = { train: 0, val: 0, test: 0 };
    for (const id of ids) counts[assignSplit(id, RATIOS, 'seed')] += 1;
    expect(counts.train / ids.length).toBeGreaterThan(0.6);
    expect(counts.train / ids.length).toBeLessThan(0.8);
    expect(counts.test).toBeGreaterThan(0);
  });

  it('sends everything to train when only train has weight', () => {
    const only = { train: 1, val: 0, test: 0 };
    for (let i = 0; i < 25; i += 1) {
      expect(assignSplit(`vid_${i}`, only, 'seed')).toBe('train');
    }
  });

  it('rejects ratios that sum to zero', () => {
    expect(() => assignSplit('vid_1', { train: 0, val: 0, test: 0 })).toThrow();
  });
});

describe('toCoco', () => {
  it('emits categories, images and annotations with matching ids', () => {
    const coco = toCoco(bundle()) as {
      categories: { id: number; name: string }[];
      images: { id: number; file_name: string }[];
      annotations: { image_id: number; category_id: number; bbox: number[] }[];
    };

    expect(coco.categories).toHaveLength(2);
    expect(coco.images).toHaveLength(1);
    expect(coco.annotations).toHaveLength(1);
    expect(coco.annotations[0]?.image_id).toBe(coco.images[0]?.id);
    expect(coco.annotations[0]?.category_id).toBe(
      coco.categories.find((c) => c.name === 'player')?.id,
    );
    // COCO bboxes are [x, y, w, h] in absolute pixels.
    expect(coco.annotations[0]?.bbox).toEqual([960, 540, 192, 216]);
  });

  it('is byte-for-byte stable across runs', () => {
    expect(JSON.stringify(toCoco(bundle()))).toBe(JSON.stringify(toCoco(bundle())));
  });

  it('drops annotations whose class is not in the class list', () => {
    const b = bundle();
    b.annotations[0] = { ...b.annotations[0]!, className: 'unicorn' };
    const coco = toCoco(b) as { annotations: unknown[] };
    expect(coco.annotations).toHaveLength(0);
  });
});

describe('toYolo', () => {
  it('normalises boxes to centre-x, centre-y, width, height', () => {
    const files = toYolo(bundle());
    const [content] = [...files.values()];
    expect(content).toBeDefined();

    const parts = content?.trim().split(' ') ?? [];
    expect(parts[0]).toBe('0'); // player is class index 0
    expect(Number(parts[1])).toBeCloseTo((960 + 192 / 2) / 1920, 5);
    expect(Number(parts[2])).toBeCloseTo((540 + 216 / 2) / 1080, 5);
    expect(Number(parts[3])).toBeCloseTo(192 / 1920, 5);
    expect(Number(parts[4])).toBeCloseTo(216 / 1080, 5);
  });

  it('files labels under their split directory', () => {
    expect([...toYolo(bundle()).keys()][0]).toMatch(/^train\//);
  });

  it('skips images with unknown dimensions rather than dividing by zero', () => {
    const b = bundle();
    b.images[0] = { ...b.images[0]!, width: 0, height: 0 };
    expect(toYolo(b).size).toBe(0);
  });
});

describe('parseFrameFileName', () => {
  it('recovers the video id and frame number', () => {
    expect(parseFrameFileName('vid_abc123_00000042.jpg')).toEqual({
      videoId: 'vid_abc123',
      frame: 42,
    });
  });

  it('works on a full path and any extension', () => {
    expect(parseFrameFileName('/a/b/labels/train/vid_x9_00000007.txt')).toEqual({
      videoId: 'vid_x9',
      frame: 7,
    });
  });

  it('returns null for names it cannot read', () => {
    expect(parseFrameFileName('nope.jpg')).toBeNull();
    expect(parseFrameFileName('vid_abc_notanumber.jpg')).toBeNull();
  });
});
