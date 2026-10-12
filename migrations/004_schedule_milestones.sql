-- Migration 004: Schedule and Milestones

CREATE TABLE IF NOT EXISTS pm_milestones (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES pm_projects(id) ON DELETE CASCADE,
  milestone_id VARCHAR(50) NOT NULL,
  title VARCHAR(255) NOT NULL,
  description TEXT,
  target_date TIMESTAMPTZ,
  github_milestone_number INT,
  client_reference_id VARCHAR(255),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_pm_milestones_project_id UNIQUE (project_id, milestone_id)
);

CREATE INDEX IF NOT EXISTS idx_pm_milestones_project ON pm_milestones (project_id);

ALTER TABLE pm_work_items ADD COLUMN IF NOT EXISTS milestone_id UUID REFERENCES pm_milestones(id) ON DELETE SET NULL;
ALTER TABLE pm_work_items ADD COLUMN IF NOT EXISTS estimated_duration INT DEFAULT 1; -- duration in days
ALTER TABLE pm_work_items ADD COLUMN IF NOT EXISTS actual_start TIMESTAMPTZ;
ALTER TABLE pm_work_items ADD COLUMN IF NOT EXISTS actual_finish TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS pm_work_item_dependencies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  predecessor_id UUID NOT NULL REFERENCES pm_work_items(id) ON DELETE CASCADE,
  successor_id UUID NOT NULL REFERENCES pm_work_items(id) ON DELETE CASCADE,
  dependency_type VARCHAR(50) NOT NULL DEFAULT 'FS' CHECK (dependency_type IN ('FS')), -- Only Finish-to-Start supported for now to ensure correctness
  lag INT NOT NULL DEFAULT 0,
  CONSTRAINT uq_pm_dependencies UNIQUE (predecessor_id, successor_id)
);

CREATE INDEX IF NOT EXISTS idx_pm_dependencies_pred ON pm_work_item_dependencies (predecessor_id);
CREATE INDEX IF NOT EXISTS idx_pm_dependencies_succ ON pm_work_item_dependencies (successor_id);

CREATE TABLE IF NOT EXISTS pm_schedules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES pm_projects(id) ON DELETE CASCADE,
  is_baseline BOOLEAN NOT NULL DEFAULT false,
  version INT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pm_schedule_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_id UUID NOT NULL REFERENCES pm_schedules(id) ON DELETE CASCADE,
  work_item_id UUID NOT NULL REFERENCES pm_work_items(id) ON DELETE CASCADE,
  early_start INT NOT NULL,
  early_finish INT NOT NULL,
  late_start INT NOT NULL,
  late_finish INT NOT NULL,
  slack INT NOT NULL,
  is_critical BOOLEAN NOT NULL DEFAULT false,
  CONSTRAINT uq_pm_schedule_item UNIQUE (schedule_id, work_item_id)
);
