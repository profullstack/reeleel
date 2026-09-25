-- ReelEel machine registry, Postgres.
-- Generated from migrations/global/0001_initial.sql with `npx libsql-pg convert-schema`, then reviewed.
-- Applied by migrate(client, 'global') when the registry client is Postgres (DATABASE_URL).
-- Timestamps stay ISO-8601 text: the app writes and compares them as strings.

create table if not exists registered_projects (
  id text PRIMARY KEY,
  root text NOT NULL UNIQUE,
  name text NOT NULL,
  sport text NOT NULL,
  added_at text NOT NULL,
  last_opened_at text
);

create table if not exists models (
  id text PRIMARY KEY,
  name text NOT NULL,
  version text NOT NULL,
  sport text NOT NULL,
  architecture text NOT NULL DEFAULT 'unknown',
  classes_json text NOT NULL DEFAULT '[]',
  runtime text NOT NULL DEFAULT 'onnx',
  license text NOT NULL DEFAULT 'unknown',
  path text,
  checksum text,
  dataset_version text,
  metrics_json text NOT NULL DEFAULT '{}',
  installed_at text NOT NULL,
  updated_at text NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_models_name_version ON models(name, version);
