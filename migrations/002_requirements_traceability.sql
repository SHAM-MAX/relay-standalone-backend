-- Migration 002: Requirements and Traceability
-- Adds requirements, work items, and their relationships.

CREATE TABLE IF NOT EXISTS pm_requirements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES pm_projects(id) ON DELETE CASCADE,
  req_id VARCHAR(50) NOT NULL,
  title VARCHAR(255) NOT NULL,
  description TEXT,
  status VARCHAR(50) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'verified', 'rejected')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_pm_req_project_req_id UNIQUE (project_id, req_id)
);

CREATE INDEX IF NOT EXISTS idx_pm_requirements_project ON pm_requirements (project_id);

CREATE TABLE IF NOT EXISTS pm_work_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES pm_projects(id) ON DELETE CASCADE,
  requirement_id UUID REFERENCES pm_requirements(id) ON DELETE CASCADE,
  item_id VARCHAR(50) NOT NULL,
  type VARCHAR(50) NOT NULL CHECK (type IN ('user_story', 'bug', 'task', 'change_request')),
  title VARCHAR(255) NOT NULL,
  description TEXT,
  status VARCHAR(50) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'completed')),
  github_issue_number INT,
  github_issue_url VARCHAR(2048),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_pm_work_items_project_item_id UNIQUE (project_id, item_id)
);

CREATE INDEX IF NOT EXISTS idx_pm_work_items_project ON pm_work_items (project_id);
CREATE INDEX IF NOT EXISTS idx_pm_work_items_requirement ON pm_work_items (requirement_id);
