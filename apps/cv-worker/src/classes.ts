/**
 * COCO class names, in the index order every COCO-trained detector emits.
 * Only the two that matter to us are commented; the rest are here so an index
 * lookup is honest rather than guessed.
 */
export const COCO_CLASSES = [
  'person', // 0  → player
  'bicycle',
  'car',
  'motorcycle',
  'airplane',
  'bus',
  'train',
  'truck',
  'boat',
  'traffic light',
  'fire hydrant',
  'stop sign',
  'parking meter',
  'bench',
  'bird',
  'cat',
  'dog',
  'horse',
  'sheep',
  'cow',
  'elephant',
  'bear',
  'zebra',
  'giraffe',
  'backpack',
  'umbrella',
  'handbag',
  'tie',
  'suitcase',
  'frisbee',
  'skis',
  'snowboard',
  'sports ball', // 32 → ball
  'kite',
  'baseball bat',
  'baseball glove',
  'skateboard',
  'surfboard',
  'tennis racket',
  'bottle',
  'wine glass',
  'cup',
  'fork',
  'knife',
  'spoon',
  'bowl',
  'banana',
  'apple',
  'sandwich',
  'orange',
  'broccoli',
  'carrot',
  'hot dog',
  'pizza',
  'donut',
  'cake',
  'chair',
  'couch',
  'potted plant',
  'bed',
  'dining table',
  'toilet',
  'tv',
  'laptop',
  'mouse',
  'remote',
  'keyboard',
  'cell phone',
  'microwave',
  'oven',
  'toaster',
  'sink',
  'refrigerator',
  'book',
  'clock',
  'vase',
  'scissors',
  'teddy bear',
  'hair drier',
  'toothbrush',
] as const;

/**
 * What a general COCO detector can honestly contribute to soccer.
 *
 * `referee`, `goalkeeper` and `goal` are NOT here, and that is the point: COCO
 * has no such classes, and every person on a pitch looks like `person` to it.
 * Guessing roles from a person box would be inventing data. Those classes wait
 * for a sport-specific model; until then the moment scorer simply gets no
 * signal from the rules that need them, which it already handles.
 */
export const COCO_TO_SPORT: Record<string, Record<number, string>> = {
  soccer: {
    0: 'player',
    32: 'ball',
  },
};

export interface ClassMapping {
  /** Model class index → ReelEel class name. */
  byIndex: Record<number, string>;
  /** Classes this model can actually produce, for reporting. */
  produces: string[];
  /** Requested classes this model cannot produce. */
  missing: string[];
}

export const mappingFor = (sport: string, requested: string[]): ClassMapping => {
  const table = COCO_TO_SPORT[sport] ?? {};
  const produces = [...new Set(Object.values(table))].filter(
    (name) => requested.length === 0 || requested.includes(name),
  );

  const byIndex: Record<number, string> = {};
  for (const [index, name] of Object.entries(table)) {
    if (produces.includes(name)) byIndex[Number(index)] = name;
  }

  return {
    byIndex,
    produces,
    missing: requested.filter((name) => !produces.includes(name)),
  };
};
