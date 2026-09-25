-- ReelEel accounts for hosted deployments, Postgres.
-- Generated from migrations/global/0002_accounts.sql with `npx libsql-pg convert-schema`, then reviewed.

create table if not exists users (
  id text PRIMARY KEY,
  email text NOT NULL,
  email_normalized text NOT NULL,
  password_hash text NOT NULL,
  display_name text,
  email_verified_at text,
  status text NOT NULL DEFAULT 'active',
  created_at text NOT NULL,
  updated_at text NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email_normalized);

create table if not exists sessions (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at text NOT NULL,
  created_at text NOT NULL,
  last_seen_at text
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id, expires_at);

create table if not exists user_tokens (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL,
  token_hash text NOT NULL,
  expires_at text NOT NULL,
  used_at text,
  created_at text NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_user_tokens_hash ON user_tokens(token_hash);

CREATE INDEX IF NOT EXISTS idx_user_tokens_user ON user_tokens(user_id, kind);

alter table registered_projects add column if not exists owner_id text;

CREATE INDEX IF NOT EXISTS idx_registered_projects_owner ON registered_projects(owner_id);
