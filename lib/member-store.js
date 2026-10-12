import db from './db.js';
import { upsertUser } from './auth.js';

export async function getMembers(projectId) {
  const res = await db.query(
    `SELECT m.id, m.user_id, m.role, u.github_id, u.github_username, m.created_at
     FROM pm_project_members m
     JOIN pm_users u ON m.user_id = u.id
     WHERE m.project_id = $1
     ORDER BY m.created_at ASC`,
    [projectId]
  );
  return res.rows;
}

export async function addMember(projectId, githubId, githubUsername, role, changedByUsername) {
  if (!['Viewer', 'Manager', 'Approver'].includes(role)) {
    throw new Error('Invalid role specified');
  }

  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    // Ensure user exists in pm_users
    const user = await upsertUser(githubId, githubUsername);

    // Insert into project_members
    const res = await client.query(
      `INSERT INTO pm_project_members (project_id, user_id, role)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [projectId, user.id, role]
    ).catch(err => {
      if (err.code === '23505' || err.message.includes('unique')) {
        throw new Error('User is already a member of this project');
      }
      throw err;
    });

    // Record history
    await client.query(
      `INSERT INTO pm_membership_history (project_id, user_id, action, new_role, changed_by)
       VALUES ($1, $2, 'added', $3, $4)`,
      [projectId, user.id, role, changedByUsername]
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

export async function updateMemberRole(projectId, targetUserId, newRole, changedByUsername) {
  if (!['Viewer', 'Manager', 'Approver'].includes(newRole)) {
    throw new Error('Invalid role specified');
  }

  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    // Lock the membership row
    const currentRes = await client.query(
      `SELECT role FROM pm_project_members WHERE project_id = $1 AND user_id = $2 FOR UPDATE`,
      [projectId, targetUserId]
    );

    if (currentRes.rows.length === 0) {
      throw new Error('Member not found in this project');
    }

    const oldRole = currentRes.rows[0].role;
    if (oldRole === newRole) {
      await client.query('ROLLBACK');
      return { success: true, message: 'Role unchanged' };
    }

    const res = await client.query(
      `UPDATE pm_project_members SET role = $1, updated_at = now()
       WHERE project_id = $2 AND user_id = $3 RETURNING *`,
      [newRole, projectId, targetUserId]
    );

    // Record history
    await client.query(
      `INSERT INTO pm_membership_history (project_id, user_id, action, old_role, new_role, changed_by)
       VALUES ($1, $2, 'role_changed', $3, $4, $5)`,
      [projectId, targetUserId, oldRole, newRole, changedByUsername]
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

export async function removeMember(projectId, targetUserId, changedByUsername) {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    // Lock the membership row
    const currentRes = await client.query(
      `SELECT role FROM pm_project_members WHERE project_id = $1 AND user_id = $2 FOR UPDATE`,
      [projectId, targetUserId]
    );

    if (currentRes.rows.length === 0) {
      throw new Error('Member not found in this project');
    }

    const oldRole = currentRes.rows[0].role;

    // Remove
    await client.query(
      `DELETE FROM pm_project_members WHERE project_id = $1 AND user_id = $2`,
      [projectId, targetUserId]
    );

    // Record history
    await client.query(
      `INSERT INTO pm_membership_history (project_id, user_id, action, old_role, changed_by)
       VALUES ($1, $2, 'removed', $3, $4)`,
      [projectId, targetUserId, oldRole, changedByUsername]
    );

    await client.query('COMMIT');
    return { success: true };
  } catch (err) {
    await client.query('ROLLBACK').catch(()=>{});
    throw err;
  } finally {
    client.release();
  }
}

export async function bootstrapProjectAdmin(projectId, authUser) {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    const adminIds = process.env.ADMIN_GITHUB_IDS ? process.env.ADMIN_GITHUB_IDS.split(',') : [];
    if (adminIds.length > 0 && !adminIds.includes(authUser.github_id)) {
      throw new Error('User is not authorized to bootstrap projects');
    }

    // Check if ANY Approver exists
    const existingApprovers = await client.query(
      `SELECT id FROM pm_project_members WHERE project_id = $1 AND role = 'Approver' FOR UPDATE`,
      [projectId]
    );

    if (existingApprovers.rows.length > 0) {
      throw new Error('Project already has an Approver. Bootstrap is not permitted.');
    }

    // Check if user is already a member
    const existingMem = await client.query(
      `SELECT role FROM pm_project_members WHERE project_id = $1 AND user_id = $2 FOR UPDATE`,
      [projectId, authUser.id]
    );

    let res;
    if (existingMem.rows.length > 0) {
      res = await client.query(
        `UPDATE pm_project_members SET role = 'Approver', updated_at = now() WHERE project_id = $1 AND user_id = $2 RETURNING *`,
        [projectId, authUser.id]
      );
      await client.query(
        `INSERT INTO pm_membership_history (project_id, user_id, action, old_role, new_role, changed_by)
         VALUES ($1, $2, 'role_changed', $3, 'Approver', 'system_bootstrap')`,
        [projectId, authUser.id, existingMem.rows[0].role]
      );
    } else {
      res = await client.query(
        `INSERT INTO pm_project_members (project_id, user_id, role) VALUES ($1, $2, 'Approver') RETURNING *`,
        [projectId, authUser.id]
      );
      await client.query(
        `INSERT INTO pm_membership_history (project_id, user_id, action, new_role, changed_by)
         VALUES ($1, $2, 'added', 'Approver', 'system_bootstrap')`,
        [projectId, authUser.id]
      );
    }

    await client.query('COMMIT');
    return res.rows[0];
  } catch (err) {
    await client.query('ROLLBACK').catch(()=>{});
    throw err;
  } finally {
    client.release();
  }
}

export default { getMembers, addMember, updateMemberRole, removeMember, bootstrapProjectAdmin };
