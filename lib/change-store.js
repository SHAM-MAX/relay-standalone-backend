import db from './db.js';

export async function createChangeRequest(projectId, data, clientReferenceId = null) {
  if (!projectId || !data.type || !data.description) {
    throw new Error('Missing required change request fields');
  }

  if (!['defect', 'scope_change'].includes(data.type)) {
    throw new Error('Invalid change request type');
  }

  if (data.type === 'defect' && !data.affectedFunctionality) {
    throw new Error('Defects must capture affected functionality');
  }

  if (data.type === 'scope_change' && (!data.impactScope || !data.impactSchedule)) {
    throw new Error('Scope changes must capture impact analysis (scope, schedule)');
  }

  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    if (clientReferenceId) {
      const existing = await client.query('SELECT * FROM pm_change_requests WHERE project_id = $1 AND client_reference_id = $2', [projectId, clientReferenceId]);
      if (existing.rows.length > 0) {
        await client.query('COMMIT');
        return existing.rows[0];
      }
    }

    const counterRes = await client.query(
      `INSERT INTO pm_project_counters (project_id, counter_type, last_value)
       VALUES ($1, 'change_request', 1)
       ON CONFLICT (project_id, counter_type)
       DO UPDATE SET last_value = pm_project_counters.last_value + 1
       RETURNING last_value`,
      [projectId]
    );
    const nextVal = counterRes.rows[0].last_value;
    const changeId = `CR-${String(nextVal).padStart(3, '0')}`;

    let impactEffort = null;
    if (data.impactEffort !== undefined && data.impactEffort !== null) {
      impactEffort = Number(data.impactEffort);
      if (!Number.isInteger(impactEffort) || impactEffort < 0) {
        throw new Error('Impact effort must be a non-negative integer or null for unknown');
      }
    }

    const res = await client.query(
      `INSERT INTO pm_change_requests (
        project_id, change_id, type, description, reason, requester,
        affected_functionality, impact_scope, impact_schedule, impact_dependencies,
        impact_effort, client_reference_id
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
      [
        projectId, changeId, data.type, data.description, data.reason || null, data.requester || null,
        data.affectedFunctionality || null, data.impactScope || null, data.impactSchedule || null,
        data.impactDependencies || null, impactEffort, clientReferenceId
      ]
    );

    const inserted = res.rows[0];

    await client.query(
      `INSERT INTO pm_change_history (change_id, action, notes, changed_by)
       VALUES ($1, 'created', 'Change request created', 'system')`,
      [inserted.id]
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

export async function updateChangeRequestStatus(projectId, id, newStatus, actor, notes = null) {
  const allowedTransitions = {
    draft: ['submitted'],
    submitted: ['under_review', 'rejected'],
    under_review: ['approved', 'rejected'],
    approved: ['implemented'],
    rejected: [],
    implemented: []
  };

  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    const currentRes = await client.query('SELECT status FROM pm_change_requests WHERE id = $1 AND project_id = $2 FOR UPDATE', [id, projectId]);
    if (currentRes.rows.length === 0) throw new Error('Change request not found or does not belong to project');

    const currentStatus = currentRes.rows[0].status;

    if (!(allowedTransitions[currentStatus] || []).includes(newStatus)) {
      throw new Error(`Invalid status transition from ${currentStatus} to ${newStatus}`);
    }

    const res = await client.query(
      `UPDATE pm_change_requests SET status = $1, updated_at = now() WHERE id = $2 RETURNING *`,
      [newStatus, id]
    );

    await client.query(
      `INSERT INTO pm_change_history (change_id, action, notes, changed_by)
       VALUES ($1, $2, $3, $4)`,
      [id, `status_changed_to_${newStatus}`, notes, actor]
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

export async function approveChangeRequest(projectId, id, actor, decisionNotes) {
  if (!actor) throw new Error('Approval requires an authorized actor');

  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    const currentRes = await client.query('SELECT status FROM pm_change_requests WHERE id = $1 AND project_id = $2 FOR UPDATE', [id, projectId]);
    if (currentRes.rows.length === 0) throw new Error('Change request not found or does not belong to project');

    const currentStatus = currentRes.rows[0].status;

    if (currentStatus !== 'under_review') {
      throw new Error('Only change requests under review can be approved');
    }

    const res = await client.query(
      `UPDATE pm_change_requests
       SET status = 'approved', approval_decision = $1, approved_by = $2, updated_at = now()
       WHERE id = $3 RETURNING *`,
      [decisionNotes || '', actor, id]
    );

    await client.query(
      `INSERT INTO pm_change_history (change_id, action, notes, changed_by)
       VALUES ($1, 'approved', $2, $3)`,
      [id, decisionNotes || 'Approved', actor]
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

export async function getChangeRequests(projectId) {
  const res = await db.query('SELECT * FROM pm_change_requests WHERE project_id = $1 ORDER BY created_at DESC', [projectId]);
  return res.rows;
}

export default { createChangeRequest, updateChangeRequestStatus, approveChangeRequest, getChangeRequests };
