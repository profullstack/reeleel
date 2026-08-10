import { describe, expect, it } from 'vitest';

import { classSidecarPath, mappingFor, parseClassSidecar, parseModelSidecar } from './classes.js';
import { decodeYolov8, headKindFor } from './yolov8.js';

/**
 * Everything here fails silently when it is wrong, which is why it is tested at
 * all. A COCO class table applied to a basketball model does not throw — it
 * reports the hoop as a bicycle. The wrong head decoder does not throw — it
 * returns a full set of plausible boxes in the wrong places. And raw 0-255
 * pixels fed to a model that wants 0-1 does not throw either: measured on the
 * real export, it produced 700 "basketball" detections at 1.00 confidence in a
 * frame of an empty gym.
 */

describe('a model that is not COCO', () => {
  it('reads its classes from a sidecar beside it', () => {
    expect(classSidecarPath('/models/bard.onnx')).toBe('/models/bard.classes.json');
    expect(classSidecarPath('/models/bard.ONNX')).toBe('/models/bard.classes.json');
  });

  it('accepts an ordered list, as YOLO data.yaml carries it', () => {
    expect(parseClassSidecar('["basketball","hoop","player","referee"]')).toEqual({
      0: 'ball',
      1: 'hoop',
      2: 'player',
      3: 'referee',
    });
  });

  it('accepts an explicit index map, and the {classes: [...]} wrapper', () => {
    expect(parseClassSidecar('{"0":"rim","2":"person"}')).toEqual({ 0: 'hoop', 2: 'player' });
    expect(parseClassSidecar('{"classes":["basketball","hoop"]}')).toEqual({
      0: 'ball',
      1: 'hoop',
    });
  });

  /** Other people's models name things their own way; the scorer has one vocabulary. */
  it('renames a model’s dialect into ours', () => {
    const table = parseClassSidecar('["basketball","rim","person","ref"]');
    expect(Object.values(table!)).toEqual(['ball', 'hoop', 'player', 'referee']);
  });

  it('survives a malformed sidecar instead of taking the run down', () => {
    expect(parseClassSidecar('not json')).toBeNull();
    expect(parseClassSidecar('[]')).toBeNull();
    expect(parseModelSidecar('not json')).toEqual({ classes: null, pixels: 'raw' });
  });

  it('defaults to raw pixels, and reads the unit convention when declared', () => {
    expect(parseModelSidecar('["ball"]').pixels).toBe('raw');
    expect(parseModelSidecar('{"classes":["ball"],"pixels":"unit"}').pixels).toBe('unit');
    // An unknown value must not silently become "unit" — that is the failure
    // mode that saturates every confidence to 1.00.
    expect(parseModelSidecar('{"classes":["ball"],"pixels":"nonsense"}').pixels).toBe('raw');
  });

  it('uses the model’s own indices rather than COCO’s', () => {
    const custom = { 0: 'ball', 1: 'hoop', 2: 'player' };
    const mapping = mappingFor('basketball', ['player', 'ball', 'hoop'], custom);
    // COCO index 1 is a bicycle; here it is the hoop, which is the whole point.
    expect(mapping.byIndex[1]).toBe('hoop');
    expect(mapping.produces).toContain('hoop');
    expect(mapping.missing).toEqual([]);
  });

  it('still reports what a COCO model genuinely cannot do', () => {
    const mapping = mappingFor('basketball', ['player', 'ball', 'hoop']);
    expect(mapping.missing).toContain('hoop');
  });
});

describe('choosing a detection head by shape', () => {
  it('reads channel-first YOLOv8 and anchor-first YOLOX apart', () => {
    // YOLOv8: [1, 4 + classes, anchors]
    expect(headKindFor([1, 8, 10164])).toBe('yolov8');
    // YOLOX: [1, anchors, 5 + classes]
    expect(headKindFor([1, 3549, 85])).toBe('yolox');
  });
});

describe('decodeYolov8', () => {
  /** One anchor, four classes, box centred at (50,60) sized 20x30. */
  const single = (classScores: number[]): Float32Array => {
    const anchors = 1;
    const data = new Float32Array((4 + classScores.length) * anchors);
    data[0] = 50;
    data[1] = 60;
    data[2] = 20;
    data[3] = 30;
    classScores.forEach((score, i) => {
      data[(4 + i) * anchors] = score;
    });
    return data;
  };

  it('converts centre/size to a top-left box', () => {
    const [detection] = decodeYolov8(single([0.9, 0.1, 0, 0]), [1, 8, 1], 0.25);
    expect(detection).toMatchObject({ x: 40, y: 45, w: 20, h: 30, classId: 0 });
    // Float32 storage, so the score comes back a hair off 0.9.
    expect(detection?.score).toBeCloseTo(0.9);
  });

  it('takes the best class, with no objectness to multiply by', () => {
    const [detection] = decodeYolov8(single([0.3, 0.4, 0.95, 0.2]), [1, 8, 1], 0.25);
    expect(detection?.classId).toBe(2);
    expect(detection?.score).toBeCloseTo(0.95);
  });

  it('drops anchors below the threshold', () => {
    expect(decodeYolov8(single([0.2, 0.1, 0.05, 0]), [1, 8, 1], 0.25)).toEqual([]);
  });

  it('returns nothing rather than guessing on a nonsense shape', () => {
    expect(decodeYolov8(new Float32Array(0), [1, 4, 0], 0.25)).toEqual([]);
    expect(decodeYolov8(new Float32Array(4), [1, 3, 1], 0.25)).toEqual([]);
  });
});
