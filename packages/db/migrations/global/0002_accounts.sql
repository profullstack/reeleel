-- Optional user accounts for hosted deployments.
--
-- Local and CLI use never touch these tables: a project on your own machine
-- still needs no account, which the PRD requires. Ownership is nullable for
-- exactly that reason — a project registered by the CLI has no owner, and must
-- keep working.

CREATE TABLE IF NOT EXISTS users (
  id                TEXT PRIMARY KEY,
  -- Lowercased, trimmed. The unique index is on this, not on the display form,
  -- so Bob@x.com and bob@x.com cannot both register.
  email             TEXT NOT NULL,
  email_normalized  TEXT NOT NULL,
  -- scrypt: `scrypt$N$r$p$salt$hash`, all base64url. No external dependency.
  password_hash     TEXT NOT NULL,
  display_name      TEXT,
  email_verified_at TEXT,
  -- 'active' | 'disabled'
  status            TEXT NOT NULL DEFAULT 'active',
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email_normalized);

-- Server-side sessions rather than a self-contained cookie, so that changing a
-- password can revoke every other session immediately.
CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id, expires_at);

-- Email verification and password reset. Only a SHA-256 hash of the token is
-- stored, so a database leak does not hand out working reset links.
CREATE TABLE IF NOT EXISTS user_tokens (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at    TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_tokens_hash ON user_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_user_tokens_user ON user_tokens(user_id, kind);

-- Ownership. NULL means "no owner" — CLI and desktop registrations, which stay
-- visible to the local user and to an admin token, but to no account.
ALTER TABLE registered_projects ADD COLUMN owner_id TEXT;
CREATE INDEX IF NOT EXISTS idx_registered_projects_owner ON registered_projects(owner_id);
