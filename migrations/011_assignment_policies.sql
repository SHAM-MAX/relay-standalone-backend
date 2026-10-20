-- Migration 011: Assignment Policy & Execution Tracking
-- Supports configurable automatic assignment mode and execution audit logs

CREATE TABLE IF NOT EXISTS pm_assignment_policies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES pm_projects(id) ON DELETE CASCADE,
  mode VARCHAR(50) NOT NULL DEFAULT 'recommendation' CHECK (mode IN ('recommendation', 'automatic')),
  min_confidence_score INTEGER NOT NULL DEFAULT 70 CHECK (min_confidence_score >= 0 AND min_confidence_score <= 100),
  enforce_capacity_limits BOOLEAN NOT NULL DEFAULT true,
  allow_growth_allocation BOOLEAN NOT NULL DEFAULT true,
  updated_by_user_id UUID REFERENCES pm_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_pm_assignment_policy_project UNIQUE (project_id)
);

CREATE INDEX IF NOT EXISTS idx_pm_assignment_policies_project ON pm_assignment_policies (project_id);

CREATE TABLE IF NOT EXISTS pm_assignment_executions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES pm_projects(id) ON DELETE CASCADE,
  issue_number INTEGER,
  github_issue_url VARCHAR(500),
  assignee VARCHAR(255) NOT NULL,
  mode VARCHAR(50) NOT NULL CHECK (mode IN ('manual_approval', 'automatic', 'manual_override')),
  status VARCHAR(50) NOT NULL CHECK (status IN ('success', 'failed', 'blocked')),
  error_message TEXT,
  evidence_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  executed_by_user_id UUID REFERENCES pm_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pm_assignment_executions_project ON pm_assignment_executions (project_id);
