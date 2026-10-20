import db from './db.js';

/**
 * Get project assignment policy. Defaults to 'recommendation' mode safely.
 */
export async function getAssignmentPolicy(projectId) {
  const res = await db.query(
    `SELECT id, project_id, mode, min_confidence_score, enforce_capacity_limits,
            allow_growth_allocation, updated_by_user_id, created_at, updated_at
     FROM pm_assignment_policies
     WHERE project_id = $1`,
    [projectId]
  );
  if (res.rows.length === 0) {
    return {
      project_id: projectId,
      mode: 'recommendation',
      min_confidence_score: 70,
      enforce_capacity_limits: true,
      allow_growth_allocation: true,
      is_default: true
    };
  }
  return res.rows[0];
}

/**
 * Update project assignment policy. Requires Manager or Approver role.
 */
export async function updateAssignmentPolicy(projectId, userId, {
  mode = 'recommendation',
  minConfidenceScore = 70,
  enforceCapacityLimits = true,
  allowGrowthAllocation = true
} = {}) {
  if (!['recommendation', 'automatic'].includes(mode)) {
    throw new Error("Mode must be either 'recommendation' or 'automatic'");
  }

  const minScore = Number(minConfidenceScore);
  if (isNaN(minScore) || minScore < 0 || minScore > 100) {
    throw new Error('minConfidenceScore must be an integer between 0 and 100');
  }

  const res = await db.query(
    `INSERT INTO pm_assignment_policies (
       project_id, mode, min_confidence_score, enforce_capacity_limits,
       allow_growth_allocation, updated_by_user_id, updated_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, now())
     ON CONFLICT (project_id)
     DO UPDATE SET
       mode = EXCLUDED.mode,
       min_confidence_score = EXCLUDED.min_confidence_score,
       enforce_capacity_limits = EXCLUDED.enforce_capacity_limits,
       allow_growth_allocation = EXCLUDED.allow_growth_allocation,
       updated_by_user_id = EXCLUDED.updated_by_user_id,
       updated_at = now()
     RETURNING *`,
    [
      projectId,
      mode,
      minScore,
      Boolean(enforceCapacityLimits),
      Boolean(allowGrowthAllocation),
      userId
    ]
  );

  return res.rows[0];
}

/**
 * Record an assignment execution audit record.
 */
export async function recordExecution({
  projectId,
  issueNumber = null,
  githubIssueUrl = null,
  assignee,
  mode,
  status,
  errorMessage = null,
  evidenceSnapshot = {},
  userId = null
}) {
  const res = await db.query(
    `INSERT INTO pm_assignment_executions (
       project_id, issue_number, github_issue_url, assignee,
       mode, status, error_message, evidence_snapshot, executed_by_user_id
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING *`,
    [
      projectId,
      issueNumber,
      githubIssueUrl,
      assignee,
      mode,
      status,
      errorMessage,
      JSON.stringify(evidenceSnapshot),
      userId
    ]
  );
  return res.rows[0];
}

/**
 * List recent assignment executions for a project.
 */
export async function listExecutions(projectId, limit = 20) {
  const res = await db.query(
    `SELECT e.*, u.github_username as executed_by_username
     FROM pm_assignment_executions e
     LEFT JOIN pm_users u ON e.executed_by_user_id = u.id
     WHERE e.project_id = $1
     ORDER BY e.created_at DESC
     LIMIT $2`,
    [projectId, Math.min(100, Math.max(1, Number(limit) || 20))]
  );
  return res.rows;
}

export default {
  getAssignmentPolicy,
  updateAssignmentPolicy,
  recordExecution,
  listExecutions
};
