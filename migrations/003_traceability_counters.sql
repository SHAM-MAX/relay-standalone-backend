-- Migration 003: Traceability Counters and Idempotency
-- Adds atomic per-project counters and client references to prevent duplicates on retries.

CREATE TABLE IF NOT EXISTS pm_project_counters (
  project_id UUID NOT NULL REFERENCES pm_projects(id) ON DELETE CASCADE,
  counter_type VARCHAR(50) NOT NULL,
  last_value INT NOT NULL DEFAULT 0,
  CONSTRAINT uq_pm_project_counters UNIQUE (project_id, counter_type)
);

ALTER TABLE pm_requirements ADD COLUMN IF NOT EXISTS client_reference_id VARCHAR(255);
CREATE INDEX IF NOT EXISTS idx_pm_req_client_ref ON pm_requirements (project_id, client_reference_id);

ALTER TABLE pm_work_items ADD COLUMN IF NOT EXISTS client_reference_id VARCHAR(255);
CREATE INDEX IF NOT EXISTS idx_pm_work_items_client_ref ON pm_work_items (project_id, client_reference_id);
