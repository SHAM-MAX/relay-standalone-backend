-- Migration 007: Membership History

CREATE TABLE IF NOT EXISTS pm_membership_history (
  id SERIAL PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES pm_projects(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES pm_users(id) ON DELETE CASCADE,
  action VARCHAR(50) NOT NULL,
  old_role VARCHAR(50),
  new_role VARCHAR(50),
  changed_by VARCHAR(255) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
