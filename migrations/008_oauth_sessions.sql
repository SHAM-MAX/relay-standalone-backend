CREATE TABLE pm_oauth_states (
  state VARCHAR(64) PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE pm_sessions (
  id VARCHAR(128) PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES pm_users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ
);

ALTER TABLE pm_users
ADD COLUMN encrypted_token TEXT,
ADD COLUMN token_iv VARCHAR(32);
