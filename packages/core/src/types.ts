/** Analysis quality/speed presets from the PRD. */
export const PRESETS = ['fast', 'balanced', 'accurate', 'thorough', 'custom'] as const;
export type Preset = (typeof PRESETS)[number];

/** Virtual Cameraman modes. `follow-ball` is experimental. */
export const CAMERA_MODES = ['follow-player', 'follow-action', 'wide', 'follow-ball'] as const;
export type CameraMode = (typeof CAMERA_MODES)[number];

export const ASPECT_RATIOS = ['16:9', '9:16', '1:1'] as const;
export type AspectRatio = (typeof ASPECT_RATIOS)[number];

export const JOB_STATUSES = [
  'queued',
  'running',
  'completed',
  'failed',
  'canceled',
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const JOB_KINDS = [
  'probe',
  'proxy',
  'thumbnails',
  'detection',
  'tracking',
  'scoring',
  'clips',
  'render',
  'dataset-export',
  'training',
] as const;
export type JobKind = (typeof JOB_KINDS)[number];

export const DATASET_FORMATS = ['coco', 'yolo', 'reeleel'] as const;
export type DatasetFormat = (typeof DATASET_FORMATS)[number];

export interface ProjectManifest {
  /** Manifest schema version — bumped independently of the app version. */
  formatVersion: number;
  id: string;
  name: string;
  sport: string;
  createdAt: string;
  updatedAt: string;
  description?: string;
  opponent?: string;
  /** Date the game was played (YYYY-MM-DD), distinct from createdAt. */
  gameDate?: string;
  tags?: string[];
}

export interface ProjectSummary extends ProjectManifest {
  root: string;
  videoCount: number;
  athleteCount: number;
  momentCount: number;
  /** False when the directory is registered but no longer on disk. */
  exists: boolean;
}

export interface VideoStreamInfo {
  codec: string;
  width: number;
  height: number;
  fps: number;
  /** Rotation metadata, in degrees — phone footage is frequently 90/270. */
  rotation: number;
}

export interface AudioStreamInfo {
  codec: string;
  channels: number;
  sampleRate: number;
}

export interface ProbeResult {
  path: string;
  container: string;
  durationSeconds: number;
  sizeBytes: number;
  bitRate: number;
  video?: VideoStreamInfo;
  audio?: AudioStreamInfo;
}

export interface SourceVideo {
  id: string;
  projectId: string;
  /** Absolute path. Source media is referenced in place by default. */
  path: string;
  /** True when the file was copied into `source/` rather than referenced. */
  copied: boolean;
  order: number;
  probe: ProbeResult | null;
  proxyPath: string | null;
  thumbnailDir: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Athlete {
  id: string;
  projectId: string;
  name: string | null;
  jerseyNumber: string | null;
  team: string | null;
  jerseyColor: string | null;
  /** Track this athlete was bound to during player selection. */
  focalTrackId: string | null;
  isFocal: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Job {
  id: string;
  projectId: string;
  kind: JobKind;
  status: JobStatus;
  stage: string | null;
  progress: number;
  etaSeconds: number | null;
  error: string | null;
  params: Record<string, unknown>;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface SuggestedMoment {
  id: string;
  projectId: string;
  videoId: string | null;
  athleteId: string | null;
  start: number;
  end: number;
  score: number;
  reasons: string[];
  /** null = undecided, true = keep, false = rejected. */
  included: boolean | null;
  favorite: boolean;
  /** User-created moments are never overwritten by re-analysis. */
  manual: boolean;
  title: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Clip {
  id: string;
  projectId: string;
  momentId: string | null;
  videoId: string | null;
  start: number;
  end: number;
  order: number;
  cameraMode: CameraMode;
  title: string | null;
  /** Made or kept by the user; regeneration leaves these alone. */
  manual: boolean;
  renderedPath: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Reel {
  id: string;
  projectId: string;
  name: string;
  aspect: AspectRatio;
  clipIds: string[];
  titleCard: string | null;
  music: string | null;
  keepOriginalAudio: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ModelRecord {
  id: string;
  name: string;
  version: string;
  sport: string;
  architecture: string;
  classes: string[];
  runtime: string;
  license: string;
  path: string | null;
  checksum: string | null;
  datasetVersion: string | null;
  metrics: Record<string, number>;
  installedAt: string;
  updatedAt: string;
}
