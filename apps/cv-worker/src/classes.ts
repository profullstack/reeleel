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
 * What a general COCO detector can honestly contribute to each sport.
 *
 * Roles — referee, goalkeeper, umpire — are deliberately absent everywhere.
 * COCO has no such classes and every person on a field looks like `person` to
 * it; guessing a role from a person box would be inventing data. So are the
 * targets (goal, hoop, net, base) and anything sport-specific COCO never saw,
 * like a hockey puck or a lacrosse stick.
 *
 * Those wait for sport-specific models. Until then the moment scorer simply
 * gets no signal from the rules that need them, which it already handles.
 */
const BALL_SPORT: Record<number, string> = { 0: 'player', 32: 'ball' };

export const COCO_TO_SPORT: Record<string, Record<number, string>> = {
  soccer: BALL_SPORT,
  basketball: BALL_SPORT,
  lacrosse: BALL_SPORT,
  football: BALL_SPORT,
  volleyball: BALL_SPORT,
  // COCO does know a bat and a glove, which is unusually generous of it.
  baseball: { 0: 'player', 32: 'ball', 34: 'bat', 35: 'glove' },
  softball: { 0: 'player', 32: 'ball', 34: 'bat', 35: 'glove' },
  // No puck in COCO, so hockey gets players and nothing else.
  hockey: { 0: 'player' },
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
