import db from './db.js';

/**
 * Validates GitHub owner and repository names.
 */
function validateOwnerRepo(owner, repository) {
  if (!owner || typeof owner !== 'string' || !/^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i.test(owner.trim())) {
    throw Object.assign(new Error('Invalid GitHub repository owner format.'), { status: 400, code: 'INVALID_PROJECT_OWNER' });
  }
  if (!repository || typeof repository !== 'string' || !/^[\w.-]{1,100}$/.test(repository.trim())) {
    throw Object.assign(new Error('Invalid GitHub repository name format.'), { status: 400, code: 'INVALID_PROJECT_REPO' });
  }
  return {
    owner: owner.trim(),
    repository: repository.trim()
  };
}

/**
 * Persists or updates project identity using the GitHub owner and repository.
 * Never stores tokens or secrets.
 */
export async function upsertProject({ owner, repository, name = null, description = null }) {
  const valid = validateOwnerRepo(owner, repository);
  const projectName = name ? String(name).slice(0, 255) : valid.repository;
  const projectDesc = description !== null && description !== undefined ? String(description).slice(0, 4000) : null;

  try {
    const result = await db.query(
      `INSERT INTO pm_projects (github_owner, github_repo, name, description)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (github_owner, github_repo)
       DO UPDATE SET
         name = COALESCE(EXCLUDED.name, pm_projects.name),
         description = COALESCE(EXCLUDED.description, pm_projects.description),
         updated_at = now()
       RETURNING *;`,
      [valid.owner, valid.repository, projectName, projectDesc]
    );

    return result.rows[0];
  } catch (error) {
    console.error('[ProjectStore Error]: Failed to upsert project:', {
      owner: valid.owner,
      repository: valid.repository,
      error: error.message
    });
    throw Object.assign(new Error(`Failed to persist project identity: ${error.message}`), {
      status: 500,
      code: 'PROJECT_PERSISTENCE_FAILED',
      cause: error
    });
  }
}

/**
 * Retrieves a project by GitHub owner and repository.
 */
export async function getProject(owner, repository) {
  const valid = validateOwnerRepo(owner, repository);
  try {
    const result = await db.query(
      'SELECT * FROM pm_projects WHERE github_owner = $1 AND github_repo = $2 LIMIT 1;',
      [valid.owner, valid.repository]
    );
    return result.rows[0] || null;
  } catch (error) {
    console.error('[ProjectStore Error]: Failed to get project:', {
      owner: valid.owner,
      repository: valid.repository,
      error: error.message
    });
    throw Object.assign(new Error(`Failed to retrieve project: ${error.message}`), {
      status: 500,
      code: 'PROJECT_QUERY_FAILED',
      cause: error
    });
  }
}

/**
 * Retrieves a project by ID.
 */
export async function getProjectById(id) {
  try {
    const result = await db.query(
      'SELECT * FROM pm_projects WHERE id = $1 LIMIT 1;',
      [id]
    );
    return result.rows[0] || null;
  } catch (error) {
    console.error('[ProjectStore Error]: Failed to get project by ID:', { id, error: error.message });
    throw Object.assign(new Error(`Failed to retrieve project: ${error.message}`), {
      status: 500,
      code: 'PROJECT_QUERY_FAILED',
      cause: error
    });
  }
}

export default {
  upsertProject,
  getProject,
  getProjectById
};
