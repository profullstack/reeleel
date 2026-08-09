-- Machine-wide schema: which projects this install knows about and which models
-- are installed. Projects remain portable; this is only an index, so losing it
-- costs nothing but a re-import.
--
-- This is the only database that may point at Turso (REELEEL_DB_URL), which is
-- what makes "my projects and models on my other machine" possible without ever
-- uploading footage.

CREATE TABLE IF NOT EXISTS registered_projects (
  id             TEXT PRIMARY KEY,
  root           TEXT NOT NULL UNIQUE,
  name           TEXT NOT NULL,
  sport          TEXT NOT NULL,
  added_at       TEXT NOT NULL,
  last_opened_at TEXT
);

CREATE TABLE IF NOT EXISTS models (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  version         TEXT NOT NULL,
  sport           TEXT NOT NULL,
  architecture    TEXT NOT NULL DEFAULT 'unknown',
  classes_json    TEXT NOT NULL DEFAULT '[]',
  runtime         TEXT NOT NULL DEFAULT 'onnx',
  license         TEXT NOT NULL DEFAULT 'unknown',
  path            TEXT,
  checksum        TEXT,
  dataset_version TEXT,
  metrics_json    TEXT NOT NULL DEFAULT '{}',
  installed_at    TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_models_name_version ON models(name, version);
