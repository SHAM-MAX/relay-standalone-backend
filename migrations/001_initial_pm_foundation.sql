-- Migration 001: Initial PM Foundation
-- Establishes project identity and persistent conversation history.

-- 1. Project Identity (keyed by GitHub owner and repository)
CREATE TABLE IF NOT EXISTS pm_projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  github_owner VARCHAR(255) NOT NULL,
  github_repo VARCHAR(255) NOT NULL,
  name VARCHAR(255),
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_pm_projects_owner_repo UNIQUE (github_owner, github_repo)
);

CREATE INDEX IF NOT EXISTS idx_pm_projects_owner_repo ON pm_projects (github_owner, github_repo);

-- 2. Conversation Sessions
CREATE TABLE IF NOT EXISTS pm_conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id VARCHAR(255) NOT NULL,
  project_id UUID REFERENCES pm_projects(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pm_conversations_member ON pm_conversations (member_id);
CREATE INDEX IF NOT EXISTS idx_pm_conversations_project ON pm_conversations (project_id);

-- 3. Conversation Messages (replaces volatile RAM memory)
CREATE TABLE IF NOT EXISTS pm_conversation_messages (
  id BIGSERIAL PRIMARY KEY,
  conversation_id UUID NOT NULL REFERENCES pm_conversations(id) ON DELETE CASCADE,
  role VARCHAR(50) NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content TEXT NOT NULL,
  model VARCHAR(100),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pm_conv_messages_conv_id ON pm_conversation_messages (conversation_id, id);
