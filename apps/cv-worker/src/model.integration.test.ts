import { existsSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { createSession } from './pipeline.js';
import { decodeYolox, predictionCount } from './yolox.js';

/**
 * Runs against a real downloaded model, which CI will not have. Set
 * REELEEL_CV_MODEL to the .onnx file to enable:
 *
 *   reeleel-cv fetch-model --sport soccer
 *   REELEEL_CV_MODEL=<path> pnpm test:run
 *
 * Its job is to catch the assumptions that unit tests cannot: the real input
 * size, the real output shape, and whether the decode grid lines up with what
 * the model actually emits.
 */
const modelPath = process.env['REELEEL_CV_MODEL'];
const available = modelPath !== undefined && modelPath.length > 0 && existsSync(modelPath);

describe.skipIf(!available)('real YOLOX model', () => {
  const SIZE = 416;

  it(
    'loads on CPU and exposes one input and one output',
    async () => {
      const session = await createSession(modelPath as string, 1);
      expect(session.inputNames.length).toBeGreaterThan(0);
      expect(session.outputNames.length).toBeGreaterThan(0);
      await session.release();
    },
    120_000,
  );

  it(
    'emits exactly the prediction count the decoder expects',
    async () => {
      const ort = await import('onnxruntime-node');
      const session = await createSession(modelPath as string, 1);
      const inputName = session.inputNames[0] as string;
      const outputName = session.outputNames[0] as string;

      // 114 is the letterbox pad colour, so this is a legitimate blank frame.
      const input = new ort.Tensor(
        'float32',
        new Float32Array(3 * SIZE * SIZE).fill(114),
        [1, 3, SIZE, SIZE],
      );
      const output = await session.run({ [inputName]: input });
      const head = output[outputName];
      expect(head).toBeDefined();

      const dims = head?.dims ?? [];
      // [batch, predictions, attributes]
      expect(dims[1]).toBe(predictionCount(SIZE, SIZE));
      expect(dims[2]).toBe(85); // 4 box + 1 objectness + 80 COCO classes

      await session.release();
    },
    120_000,
  );

  it(
    'produces no confident detections on a blank frame',
    async () => {
      const ort = await import('onnxruntime-node');
      const session = await createSession(modelPath as string, 1);
      const inputName = session.inputNames[0] as string;
      const outputName = session.outputNames[0] as string;

      const input = new ort.Tensor(
        'float32',
        new Float32Array(3 * SIZE * SIZE).fill(114),
        [1, 3, SIZE, SIZE],
      );
      const output = await session.run({ [inputName]: input });
      const head = output[outputName];
      const raw = head?.data as Float32Array;

      const detections = decodeYolox(raw, head?.dims[2] ?? 85, {
        inputWidth: SIZE,
        inputHeight: SIZE,
        scoreThreshold: 0.5,
      });
      // Grey noise should not hallucinate players; anything here means the
      // decode is misreading the tensor layout.
      expect(detections.length).toBe(0);

      await session.release();
    },
    120_000,
  );
});
