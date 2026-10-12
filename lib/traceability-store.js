import db from './db.js';

export async function createRequirement(projectId, title, description, status = 'draft', clientReferenceId = null) {
  if (!projectId || !title) throw new Error('Missing projectId or title');
  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    // Idempotency check
    if (clientReferenceId) {
      const existing = await client.query('SELECT * FROM pm_requirements WHERE project_id = $1 AND client_reference_id = $2', [projectId, clientReferenceId]);
      if (existing.rows.length > 0) {
        await client.query('COMMIT');
        return existing.rows[0];
      }
    }

    const counterRes = await client.query(
      `INSERT INTO pm_project_counters (project_id, counter_type, last_value)
       VALUES ($1, 'requirement', 1)
       ON CONFLICT (project_id, counter_type)
       DO UPDATE SET last_value = pm_project_counters.last_value + 1
       RETURNING last_value`,
      [projectId]
    );
    const nextVal = counterRes.rows[0].last_value;
    const reqId = `REQ-${String(nextVal).padStart(3, '0')}`;

    const res = await client.query(
      `INSERT INTO pm_requirements (project_id, req_id, title, description, status, client_reference_id)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [projectId, reqId, title, description || '', status, clientReferenceId]
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

export async function getRequirements(projectId) {
  const res = await db.query('SELECT * FROM pm_requirements WHERE project_id = $1 ORDER BY created_at DESC', [projectId]);
  return res.rows;
}

export async function createWorkItem(projectId, requirementId, type, title, description, status = 'draft', clientReferenceId = null) {
  if (!projectId || !type || !title) throw new Error('Missing required fields for work item');
  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    // Idempotency check
    if (clientReferenceId) {
      const existing = await client.query('SELECT * FROM pm_work_items WHERE project_id = $1 AND client_reference_id = $2', [projectId, clientReferenceId]);
      if (existing.rows.length > 0) {
        await client.query('COMMIT');
        return existing.rows[0];
      }
    }

    const counterRes = await client.query(
      `INSERT INTO pm_project_counters (project_id, counter_type, last_value)
       VALUES ($1, 'work_item', 1)
       ON CONFLICT (project_id, counter_type)
       DO UPDATE SET last_value = pm_project_counters.last_value + 1
       RETURNING last_value`,
      [projectId]
    );
    const nextVal = counterRes.rows[0].last_value;
    const prefix = type === 'bug' ? 'BUG' : type === 'task' ? 'TSK' : type === 'user_story' ? 'USR' : 'CRQ';
    const itemId = `${prefix}-${String(nextVal).padStart(3, '0')}`;

    const res = await client.query(
      `INSERT INTO pm_work_items (project_id, requirement_id, item_id, type, title, description, status, client_reference_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [projectId, requirementId || null, itemId, type, title, description || '', status, clientReferenceId]
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

export async function updateWorkItemGitHubLink(id, issueNumber, issueUrl) {
  const res = await db.query(
    `UPDATE pm_work_items SET github_issue_number = $1, github_issue_url = $2, status = 'published', updated_at = now()
     WHERE id = $3 RETURNING *`,
    [issueNumber, issueUrl, id]
  );
  return res.rows[0];
}

export async function getTraceability(projectId) {
  const reqs = await db.query('SELECT * FROM pm_requirements WHERE project_id = $1 ORDER BY created_at ASC', [projectId]);
  const items = await db.query('SELECT * FROM pm_work_items WHERE project_id = $1 ORDER BY created_at ASC', [projectId]);

  return reqs.rows.map(r => {
    return {
      ...r,
      workItems: items.rows.filter(i => i.requirement_id === r.id)
    };
  });
}

export default { createRequirement, getRequirements, createWorkItem, updateWorkItemGitHubLink, getTraceability };
