-- Migration 005: Risk Management and Change Control

CREATE TABLE IF NOT EXISTS pm_risks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES pm_projects(id) ON DELETE CASCADE,
  risk_id VARCHAR(50) NOT NULL,
  title VARCHAR(255) NOT NULL,
  description TEXT,
  category VARCHAR(100),
  probability INT NOT NULL CHECK (probability >= 1 AND probability <= 5),
  impact INT NOT NULL CHECK (impact >= 1 AND impact <= 5),
  score INT NOT NULL,
  mitigation_strategy TEXT,
  response VARCHAR(50) CHECK (response IS NULL OR response IN ('avoid', 'mitigate', 'transfer', 'accept')),
  owner VARCHAR(255),
  status VARCHAR(50) NOT NULL DEFAULT 'identified' CHECK (status IN ('identified', 'assessed', 'active', 'mitigated', 'closed')),
  work_item_id UUID REFERENCES pm_work_items(id) ON DELETE SET NULL,
  milestone_id UUID REFERENCES pm_milestones(id) ON DELETE SET NULL,
  client_reference_id VARCHAR(255),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_pm_risks_project_id UNIQUE (project_id, risk_id)
);

CREATE TABLE IF NOT EXISTS pm_risk_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  risk_id UUID NOT NULL REFERENCES pm_risks(id) ON DELETE CASCADE,
  field_name VARCHAR(50) NOT NULL,
  old_value TEXT,
  new_value TEXT,
  changed_by VARCHAR(255),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pm_change_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES pm_projects(id) ON DELETE CASCADE,
  change_id VARCHAR(50) NOT NULL,
  type VARCHAR(50) NOT NULL CHECK (type IN ('defect', 'scope_change')),
  description TEXT NOT NULL,
  reason TEXT,
  requester VARCHAR(255),
  status VARCHAR(50) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitted', 'under_review', 'approved', 'rejected', 'implemented')),

  -- Defect specific
  affected_functionality TEXT,

  -- Scope change specific
  impact_scope TEXT,
  impact_schedule TEXT,
  impact_dependencies TEXT,
  impact_effort INT, -- NULL means unknown, 0 means zero impact

  feasibility_assessment TEXT,
  approval_decision TEXT,
  approved_by VARCHAR(255),

  client_reference_id VARCHAR(255),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_pm_changes_project_id UNIQUE (project_id, change_id)
);

CREATE TABLE IF NOT EXISTS pm_change_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  change_id UUID NOT NULL REFERENCES pm_change_requests(id) ON DELETE CASCADE,
  action VARCHAR(100) NOT NULL,
  notes TEXT,
  changed_by VARCHAR(255),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
