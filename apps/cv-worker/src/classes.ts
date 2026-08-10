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

/** Where a model's class list lives, if it has one: `<model>.classes.json`. */
export const classSidecarPath = (modelPath: string): string =>
  `${modelPath.replace(/\.onnx$/i, '')}.classes.json`;

/**
 * How a model wants its pixels.
 *
 * YOLOX takes raw 0-255; YOLOv8 expects 0-1. Getting this wrong does not throw
 * — every class saturates to 1.00 confidence and the model reports a ball, a
 * hoop and a referee in a photograph of an empty gym. Measured: feeding a
 * YOLOv8 export raw bytes produced 700 "basketball" detections at 1.00 in a
 * frame containing no ball at all.
 */
export type PixelScale = 'raw' | 'unit';

export interface ModelSidecar {
  classes: Record<number, string> | null;
  pixels: PixelScale;
}

/** Reads both the class list and the pixel convention from one sidecar. */
export const parseModelSidecar = (raw: string): ModelSidecar => {
  const classes = parseClassSidecar(raw);
  let pixels: PixelScale = 'raw';
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null && 'pixels' in parsed) {
      const value = (parsed as { pixels: unknown }).pixels;
      if (value === 'unit' || value === 'raw') pixels = value;
    }
  } catch {
    // A malformed sidecar is already reported by parseClassSidecar returning null.
  }
  return { classes, pixels };
};

/**
 * A model's own class list, read from a `<model>.classes.json` sidecar.
 *
 * Either shape is accepted, because both are what the tools in this space
 * actually emit: an ordered list of names as YOLO's `data.yaml` carries, or an
 * explicit index-to-name object.
 *
 *   ["ball", "hoop", "player"]
 *   { "0": "ball", "1": "hoop", "2": "player" }
 *
 * Names are the ReelEel vocabulary — `player`, `ball`, `hoop`, `referee` — so a
 * model whose own label is `basketball` or `rim` is renamed here rather than
 * teaching the rest of the system every model's dialect. Anything unrecognised
 * is carried through and simply never asked for.
 */
export const parseClassSidecar = (raw: string): Record<number, string> | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  const named = (value: unknown): string | null =>
    typeof value === 'string' && value.trim().length > 0 ? SYNONYMS[value.trim().toLowerCase()] ?? value.trim().toLowerCase() : null;

  if (Array.isArray(parsed)) {
    const table: Record<number, string> = {};
    parsed.forEach((value, index) => {
      const name = named(value);
      if (name !== null) table[index] = name;
    });
    return Object.keys(table).length > 0 ? table : null;
  }

  if (typeof parsed === 'object' && parsed !== null) {
    const source = 'classes' in parsed ? (parsed as { classes: unknown }).classes : parsed;
    if (Array.isArray(source)) return parseClassSidecar(JSON.stringify(source));
    if (typeof source !== 'object' || source === null) return null;

    const table: Record<number, string> = {};
    for (const [key, value] of Object.entries(source)) {
      const index = Number(key);
      const name = named(value);
      if (Number.isInteger(index) && index >= 0 && name !== null) table[index] = name;
    }
    return Object.keys(table).length > 0 ? table : null;
  }

  return null;
};

/** What other people's basketball models call the things we already name. */
const SYNONYMS: Record<string, string> = {
  basketball: 'ball',
  ball: 'ball',
  'sports ball': 'ball',
  rim: 'hoop',
  hoop: 'hoop',
  basket: 'hoop',
  net: 'hoop',
  backboard: 'hoop',
  person: 'player',
  players: 'player',
  player: 'player',
  ref: 'referee',
  referee: 'referee',
};

export const mappingFor = (
  sport: string,
  requested: string[],
  /**
   * The model's own classes, when it is not a COCO model. Supplying this is the
   * difference between a basketball model working and being silently misread —
   * its index 1 is a hoop, and COCO's index 1 is a bicycle.
   */
  custom?: Record<number, string> | null,
): ClassMapping => {
  const table = custom ?? COCO_TO_SPORT[sport] ?? {};
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
