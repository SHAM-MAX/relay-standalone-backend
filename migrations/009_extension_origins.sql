-- Migration 009: Extension Origins
-- Stores approved extension origins to pass CORS preflight for multiple dynamic users.

CREATE TABLE IF NOT EXISTS pm_extension_origins (
  origin VARCHAR(255) PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
