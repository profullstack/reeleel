-- Project-local schema. One database per project directory, so a project stays
-- portable: copy the folder and every job, track and moment travels with it.
-- Forward-only. Never edit a shipped migration; add a new numbered file.

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS source_videos (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL,
  path          TEXT NOT NULL,
  copied        INTEGER NOT NULL DEFAULT 0,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  probe_json    TEXT,
  proxy_path    TEXT,
  thumbnail_dir TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_source_videos_path ON source_videos(path);

CREATE TABLE IF NOT EXISTS teams (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  name       TEXT NOT NULL,
  color      TEXT,
  is_home    INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS athletes (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL,
  name           TEXT,
  jersey_number  TEXT,
  team           TEXT,
  jersey_color   TEXT,
  focal_track_id TEXT,
  is_focal       INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL,
  kind        TEXT NOT NULL,
  status      TEXT NOT NULL,
  stage       TEXT,
  progress    REAL NOT NULL DEFAULT 0,
  eta_seconds REAL,
  error       TEXT,
  params_json TEXT NOT NULL DEFAULT '{}',
  created_at  TEXT NOT NULL,
  started_at  TEXT,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status, created_at);

CREATE TABLE IF NOT EXISTS job_logs (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id  TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  at      TEXT NOT NULL,
  level   TEXT NOT NULL,
  message TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_job_logs_job ON job_logs(job_id, id);

CREATE TABLE IF NOT EXISTS tracks (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL,
  video_id    TEXT REFERENCES source_videos(id) ON DELETE CASCADE,
  class       TEXT NOT NULL,
  athlete_id  TEXT REFERENCES athletes(id) ON DELETE SET NULL,
  confidence  REAL NOT NULL DEFAULT 0,
  start_frame INTEGER,
  end_frame   INTEGER,
  uncertain   INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tracks_video ON tracks(video_id, class);

CREATE TABLE IF NOT EXISTS track_points (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  track_id   TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  frame      INTEGER NOT NULL,
  ts         REAL NOT NULL,
  x          REAL NOT NULL,
  y          REAL NOT NULL,
  w          REAL NOT NULL,
  h          REAL NOT NULL,
  confidence REAL NOT NULL DEFAULT 0,
  occluded   INTEGER NOT NULL DEFAULT 0,
  source     TEXT NOT NULL DEFAULT 'model'
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_track_points_frame ON track_points(track_id, frame);

CREATE TABLE IF NOT EXISTS detections (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  video_id   TEXT NOT NULL REFERENCES source_videos(id) ON DELETE CASCADE,
  frame      INTEGER NOT NULL,
  ts         REAL NOT NULL,
  class      TEXT NOT NULL,
  x          REAL NOT NULL,
  y          REAL NOT NULL,
  w          REAL NOT NULL,
  h          REAL NOT NULL,
  confidence REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_detections_frame ON detections(video_id, frame);

CREATE TABLE IF NOT EXISTS annotations (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL,
  video_id     TEXT REFERENCES source_videos(id) ON DELETE CASCADE,
  track_id     TEXT REFERENCES tracks(id) ON DELETE SET NULL,
  frame        INTEGER NOT NULL,
  ts           REAL NOT NULL,
  class        TEXT NOT NULL,
  x            REAL NOT NULL,
  y            REAL NOT NULL,
  w            REAL NOT NULL,
  h            REAL NOT NULL,
  occluded     INTEGER NOT NULL DEFAULT 0,
  out_of_frame INTEGER NOT NULL DEFAULT 0,
  keyframe     INTEGER NOT NULL DEFAULT 1,
  author       TEXT NOT NULL DEFAULT 'human',
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_annotations_frame ON annotations(video_id, frame);

CREATE TABLE IF NOT EXISTS suggested_moments (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL,
  video_id     TEXT REFERENCES source_videos(id) ON DELETE CASCADE,
  athlete_id   TEXT REFERENCES athletes(id) ON DELETE SET NULL,
  start_ts     REAL NOT NULL,
  end_ts       REAL NOT NULL,
  score        REAL NOT NULL DEFAULT 0,
  reasons_json TEXT NOT NULL DEFAULT '[]',
  included     INTEGER,
  favorite     INTEGER NOT NULL DEFAULT 0,
  manual       INTEGER NOT NULL DEFAULT 0,
  title        TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_moments_time ON suggested_moments(start_ts);

CREATE TABLE IF NOT EXISTS clips (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL,
  moment_id     TEXT REFERENCES suggested_moments(id) ON DELETE SET NULL,
  video_id      TEXT REFERENCES source_videos(id) ON DELETE CASCADE,
  start_ts      REAL NOT NULL,
  end_ts        REAL NOT NULL,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  camera_mode   TEXT NOT NULL DEFAULT 'follow-player',
  title         TEXT,
  rendered_path TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reels (
  id                  TEXT PRIMARY KEY,
  project_id          TEXT NOT NULL,
  name                TEXT NOT NULL,
  aspect              TEXT NOT NULL DEFAULT '16:9',
  title_card          TEXT,
  music               TEXT,
  keep_original_audio INTEGER NOT NULL DEFAULT 1,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_reels_name ON reels(name);

CREATE TABLE IF NOT EXISTS reel_clips (
  reel_id    TEXT NOT NULL REFERENCES reels(id) ON DELETE CASCADE,
  clip_id    TEXT NOT NULL REFERENCES clips(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (reel_id, clip_id)
);

CREATE TABLE IF NOT EXISTS exports (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  reel_id    TEXT REFERENCES reels(id) ON DELETE SET NULL,
  path       TEXT NOT NULL,
  aspect     TEXT NOT NULL,
  created_at TEXT NOT NULL
);
