import db from './db.js';

/**
 * Get a developer profile by project and user ID.
 */
export async function getDeveloperProfile(projectId, userId) {
  const res = await db.query(
    `SELECT dp.id, dp.project_id, dp.user_id, dp.declared_skills, 
            dp.weekly_capacity_hours, dp.max_concurrent_tasks, dp.is_available,
            dp.current_focus, dp.created_at, dp.updated_at,
            u.github_id, u.github_username
     FROM pm_developer_profiles dp
     JOIN pm_users u ON dp.user_id = u.id
     WHERE dp.project_id = $1 AND dp.user_id = $2`,
    [projectId, userId]
  );
  return res.rows[0] || null;
}

/**
 * Get all developer profiles for a project.
 */
export async function listProjectDeveloperProfiles(projectId) {
  const res = await db.query(
    `SELECT dp.id, dp.project_id, dp.user_id, dp.declared_skills, 
            dp.weekly_capacity_hours, dp.max_concurrent_tasks, dp.is_available,
            dp.current_focus, dp.created_at, dp.updated_at,
            u.github_id, u.github_username, m.role
     FROM pm_developer_profiles dp
     JOIN pm_users u ON dp.user_id = u.id
     LEFT JOIN pm_project_members m ON m.project_id = dp.project_id AND m.user_id = dp.user_id
     WHERE dp.project_id = $1
     ORDER BY u.github_username ASC`,
    [projectId]
  );
  return res.rows;
}

/**
 * Upsert a developer profile. Declared skills and availability must be explicit.
 */
export async function upsertDeveloperProfile(projectId, userId, {
  declaredSkills = [],
  weeklyCapacityHours = 40,
  maxConcurrentTasks = 3,
  isAvailable = true,
  currentFocus = null
} = {}) {
  // Validate fields
  if (!Array.isArray(declaredSkills)) {
    throw new Error('declaredSkills must be an array of strings');
  }

  const cleanSkills = declaredSkills
    .filter(s => typeof s === 'string' && s.trim().length > 0)
    .map(s => s.trim().toLowerCase());

  const capacity = Number(weeklyCapacityHours);
  if (isNaN(capacity) || capacity < 0 || capacity > 168) {
    throw new Error('weeklyCapacityHours must be between 0 and 168');
  }

  const maxTasks = Number(maxConcurrentTasks);
  if (isNaN(maxTasks) || maxTasks < 1 || maxTasks > 50) {
    throw new Error('maxConcurrentTasks must be between 1 and 50');
  }

  const available = Boolean(isAvailable);
  const focus = currentFocus ? String(currentFocus).slice(0, 255) : null;

  const res = await db.query(
    `INSERT INTO pm_developer_profiles (
       project_id, user_id, declared_skills, weekly_capacity_hours,
       max_concurrent_tasks, is_available, current_focus, updated_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, now())
     ON CONFLICT (project_id, user_id)
     DO UPDATE SET
       declared_skills = EXCLUDED.declared_skills,
       weekly_capacity_hours = EXCLUDED.weekly_capacity_hours,
       max_concurrent_tasks = EXCLUDED.max_concurrent_tasks,
       is_available = EXCLUDED.is_available,
       current_focus = EXCLUDED.current_focus,
       updated_at = now()
     RETURNING *`,
    [projectId, userId, cleanSkills, capacity, maxTasks, available, focus]
  );

  return res.rows[0];
}

export default {
  getDeveloperProfile,
  listProjectDeveloperProfiles,
  upsertDeveloperProfile
};
