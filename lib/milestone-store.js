import db from './db.js';

export async function createMilestone(projectId, title, description, targetDate, clientReferenceId = null) {
  if (!projectId || !title) throw new Error('Missing projectId or title');
  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    if (clientReferenceId) {
      const existing = await client.query('SELECT * FROM pm_milestones WHERE project_id = $1 AND client_reference_id = $2', [projectId, clientReferenceId]);
      if (existing.rows.length > 0) {
        await client.query('COMMIT');
        return existing.rows[0];
      }
    }

    const counterRes = await client.query(
      `INSERT INTO pm_project_counters (project_id, counter_type, last_value)
       VALUES ($1, 'milestone', 1)
       ON CONFLICT (project_id, counter_type)
       DO UPDATE SET last_value = pm_project_counters.last_value + 1
       RETURNING last_value`,
      [projectId]
    );
    const nextVal = counterRes.rows[0].last_value;
    const milestoneId = `MS-${String(nextVal).padStart(3, '0')}`;

    const res = await client.query(
      `INSERT INTO pm_milestones (project_id, milestone_id, title, description, target_date, client_reference_id)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [projectId, milestoneId, title, description || '', targetDate || null, clientReferenceId]
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

export async function getMilestones(projectId) {
  const res = await db.query('SELECT * FROM pm_milestones WHERE project_id = $1 ORDER BY created_at DESC', [projectId]);
  return res.rows;
}

export async function getMilestoneHealth(projectId) {
  // Aggregate work item statuses per milestone
  const res = await db.query(`
    SELECT m.id, m.milestone_id, m.title, m.target_date,
           COUNT(w.id) as total_items,
           SUM(CASE WHEN w.status = 'completed' THEN 1 ELSE 0 END) as completed_items,
           SUM(CASE WHEN w.status = 'published' THEN 1 ELSE 0 END) as in_progress_items,
           SUM(CASE WHEN w.status = 'draft' THEN 1 ELSE 0 END) as draft_items
    FROM pm_milestones m
    LEFT JOIN pm_work_items w ON w.milestone_id = m.id
    WHERE m.project_id = $1
    GROUP BY m.id, m.milestone_id, m.title, m.target_date
  `, [projectId]);

  return res.rows.map(row => {
    const total = parseInt(row.total_items, 10);
    const completed = parseInt(row.completed_items, 10);
    const inProgress = parseInt(row.in_progress_items, 10);
    const draft = parseInt(row.draft_items, 10);
    const health = total === 0 ? 'unknown' : (completed === total ? 'completed' : 'on_track');
    // Note: To calculate true health, we'd compare expected finish from schedule against target_date.
    return {
      id: row.id,
      milestone_id: row.milestone_id,
      title: row.title,
      target_date: row.target_date,
      total_items: total,
      completed_items: completed,
      in_progress_items: inProgress,
      draft_items: draft,
      health
    };
  });
}

export default { createMilestone, getMilestones, getMilestoneHealth };
