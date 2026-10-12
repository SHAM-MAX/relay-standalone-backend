-- Migration 006: Secure Auth and Project RBAC

CREATE TABLE IF NOT EXISTS pm_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  github_id VARCHAR(255) UNIQUE NOT NULL,
  github_username VARCHAR(255) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pm_project_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES pm_projects(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES pm_users(id) ON DELETE CASCADE,
  role VARCHAR(50) NOT NULL DEFAULT 'Viewer' CHECK (role IN ('Viewer', 'Manager', 'Approver')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_project_member UNIQUE(project_id, user_id)
);
