-- Migration 010: Developer Profiles for Assignment Intelligence

CREATE TABLE IF NOT EXISTS pm_developer_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES pm_projects(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES pm_users(id) ON DELETE CASCADE,
  declared_skills TEXT[] NOT NULL DEFAULT '{}',
  weekly_capacity_hours INTEGER NOT NULL DEFAULT 40 CHECK (weekly_capacity_hours >= 0 AND weekly_capacity_hours <= 168),
  max_concurrent_tasks INTEGER NOT NULL DEFAULT 3 CHECK (max_concurrent_tasks >= 1 AND max_concurrent_tasks <= 50),
  is_available BOOLEAN NOT NULL DEFAULT true,
  current_focus VARCHAR(255) DEFAULT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_dev_profile_project_user UNIQUE (project_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_pm_developer_profiles_project ON pm_developer_profiles(project_id);
