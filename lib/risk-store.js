import db from './db.js';

export async function createRisk(projectId, data, clientReferenceId = null) {
  if (!projectId || !data.title || !data.probability || !data.impact) {
    throw new Error('Missing required risk fields');
  }

  const prob = Number(data.probability);
  const imp = Number(data.impact);

  if (!Number.isInteger(prob) || prob < 1 || prob > 5) throw new Error('Probability must be between 1 and 5');
  if (!Number.isInteger(imp) || imp < 1 || imp > 5) throw new Error('Impact must be between 1 and 5');

  const score = prob * imp;

  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    if (clientReferenceId) {
      const existing = await client.query('SELECT * FROM pm_risks WHERE project_id = $1 AND client_reference_id = $2', [projectId, clientReferenceId]);
      if (existing.rows.length > 0) {
        await client.query('COMMIT');
        return existing.rows[0];
      }
    }

    const counterRes = await client.query(
      `INSERT INTO pm_project_counters (project_id, counter_type, last_value)
       VALUES ($1, 'risk', 1)
       ON CONFLICT (project_id, counter_type)
       DO UPDATE SET last_value = pm_project_counters.last_value + 1
       RETURNING last_value`,
      [projectId]
    );
    const nextVal = counterRes.rows[0].last_value;
    const riskId = `RSK-${String(nextVal).padStart(3, '0')}`;

    const res = await client.query(
      `INSERT INTO pm_risks (
        project_id, risk_id, title, description, category, probability, impact, score,
        mitigation_strategy, response, owner, status, work_item_id, milestone_id, client_reference_id
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING *`,
      [
        projectId, riskId, data.title, data.description || null, data.category || null,
        prob, imp, score, data.mitigationStrategy || null, data.response || null,
        data.owner || null, data.status || 'identified', data.workItemId || null,
        data.milestoneId || null, clientReferenceId
      ]
    );

    const inserted = res.rows[0];

    await client.query(
      `INSERT INTO pm_risk_history (risk_id, field_name, old_value, new_value, changed_by)
       VALUES ($1, 'status', NULL, $2, $3)`,
      [inserted.id, inserted.status, 'system']
    );

    await client.query('COMMIT');
    return inserted;
  } catch (err) {
    await client.query('ROLLBACK').catch(()=>{});
    throw err;
  } finally {
    client.release();
  }
}

export async function getProjectRiskSummary(projectId) {
  const res = await db.query(`
    SELECT
      COUNT(*) as total_risks,
      SUM(CASE WHEN status IN ('identified', 'assessed', 'active') THEN 1 ELSE 0 END) as open_risks,
      MAX(score) as max_score,
      SUM(CASE WHEN score >= 15 THEN 1 ELSE 0 END) as high_risks
    FROM pm_risks
    WHERE project_id = $1
  `, [projectId]);

  const row = res.rows[0];
  return {
    totalRisks: Number(row.total_risks) || 0,
    openRisks: Number(row.open_risks) || 0,
    maxScore: Number(row.max_score) || 0,
    highRisks: Number(row.high_risks) || 0
  };
}

export async function getRisks(projectId) {
  const res = await db.query('SELECT * FROM pm_risks WHERE project_id = $1 ORDER BY created_at DESC', [projectId]);
  return res.rows;
}

export async function updateRiskStatus(projectId, riskId, newStatus, actor) {
  const allowedTransitions = {
    identified: ['assessed', 'closed'],
    assessed: ['active', 'closed'],
    active: ['mitigated', 'closed'],
    mitigated: ['closed'],
    closed: []
  };

  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    const currentRes = await client.query('SELECT status FROM pm_risks WHERE id = $1 AND project_id = $2 FOR UPDATE', [riskId, projectId]);
    if (currentRes.rows.length === 0) throw new Error('Risk not found or does not belong to project');

    const currentStatus = currentRes.rows[0].status;

    if (!(allowedTransitions[currentStatus] || []).includes(newStatus)) {
      throw new Error(`Invalid status transition from ${currentStatus} to ${newStatus}`);
    }

    const res = await client.query(
      `UPDATE pm_risks SET status = $1, updated_at = now() WHERE id = $2 RETURNING *`,
      [newStatus, riskId]
    );

    await client.query(
      `INSERT INTO pm_risk_history (risk_id, field_name, old_value, new_value, changed_by)
       VALUES ($1, 'status', $2, $3, $4)`,
      [riskId, currentStatus, newStatus, actor || 'system']
    );

    await client.query('COMMIT');
    return res.rows[0];
  } catch (err) {
    await client.query('ROLLBACK').catch(()=>{});
    throw err;
  } finally {
    client.release();
  }
}

export default { createRisk, getProjectRiskSummary, getRisks, updateRiskStatus };
