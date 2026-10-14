import express from 'express';
import { authenticateRequest, authorizeProjectAction, decryptToken, getProjectRole, setProjectRole } from '../../lib/auth.js';
import { RELAY_ORIGIN, header, hasOrigin, corsHeaders } from '../../lib/assistant-access.js';
import developerStore from '../../lib/developer-store.js';
import projectStore from '../../lib/project-store.js';
import githubEvidence from '../../lib/github-evidence.js';
import assignmentEngine from '../../lib/assignment-engine.js';
import db from '../../lib/db.js';

const router = express.Router();

// Attach CORS middleware for Chrome Extension cross-origin requests
router.use(async (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Vary', 'Origin');

  const origin = header(req, 'origin');
  const approvedOrigin = origin === RELAY_ORIGIN || await hasOrigin(origin);

  if (approvedOrigin) {
    corsHeaders(res, origin, 'GET, POST, PUT, OPTIONS');
  }

  if (req.method === 'OPTIONS') {
    if (!approvedOrigin) {
      return res.status(403).json({ error: 'Origin not allowed' });
    }
    return res.status(204).send('');
  }

  next();
});

function getOwnerRepo(req) {
  let rawOwner = (req.query.owner || req.body?.owner || '').toString().trim();
  let rawRepo = (req.query.repo || req.body?.repo || '').toString().trim();

  if (rawRepo.includes('/')) {
    const parts = rawRepo.split('/').map(p => p.trim()).filter(Boolean);
    if (parts.length >= 2) {
      if (!rawOwner) rawOwner = parts[0];
      rawRepo = parts[parts.length - 1];
    } else if (parts.length === 1) {
      rawRepo = parts[0];
    }
  }

  rawRepo = rawRepo.replace(/\.git$/i, '').replace(/^\/+|\/+$/g, '');
  rawOwner = rawOwner.replace(/^\/+|\/+$/g, '');

  return { owner: rawOwner, repo: rawRepo };
}

async function getOrCreateProjectAndAuthorize(req, requiredRole = 'Viewer') {
  const { owner, repo } = getOwnerRepo(req);
  if (!owner || !repo) {
    const err = new Error('owner and repo are required');
    err.status = 400;
    throw err;
  }

  let project = await projectStore.getProject(owner, repo);
  if (!project) {
    project = await projectStore.upsertProject({
      owner,
      repository: repo,
      description: null
    });
  }

  // Authenticate user via session
  const authUser = await authenticateRequest(req);

  // Check project membership; auto-bootstrap as Approver/Manager if user is owner or first member
  let role = await getProjectRole(project.id, authUser.id);
  if (!role) {
    const isOwner = (authUser.github_username || '').toLowerCase() === owner.toLowerCase();
    const assignedRole = isOwner ? 'Approver' : 'Viewer';
    await setProjectRole(project.id, authUser.id, assignedRole);
    role = assignedRole;
  }

  const roleHierarchy = { 'Viewer': 1, 'Manager': 2, 'Approver': 3 };
  if ((roleHierarchy[role] || 0) < (roleHierarchy[requiredRole] || 0)) {
    const err = new Error(`Action requires ${requiredRole} role, but user is ${role}`);
    err.status = 403;
    throw err;
  }

  return { project, authUser, owner, repo };
}

/**
 * GET /api/pm/assignment/profile
 * Get developer profile for current user or project members.
 */
router.get('/profile', async (req, res) => {
  try {
    const { project, authUser } = await getOrCreateProjectAndAuthorize(req, 'Viewer');

    // If targetUserId query param is passed and user is Manager/Approver, allow reading other's profile
    const targetUserId = req.query.userId || authUser.id;
    const profile = await developerStore.getDeveloperProfile(project.id, targetUserId);

    return res.json({ profile });
  } catch (err) {
    const status = err.status || (
      err.message.includes('not a member') ? 403 :
      err.message.includes('cookie') ? 401 : 500
    );
    return res.status(status).json({ error: err.message });
  }
});

/**
 * PUT /api/pm/assignment/profile
 * Upsert developer profile for the user or by Manager/Approver for another user.
 */
router.put('/profile', async (req, res) => {
  try {
    const authUser = await authenticateRequest(req);
    const targetUserId = req.body.userId || authUser.id;

    // If editing another user's profile, require Manager or Approver role
    const requiredRole = (targetUserId !== authUser.id) ? 'Manager' : 'Viewer';
    const { project } = await getOrCreateProjectAndAuthorize(req, requiredRole);

    const { declaredSkills, weeklyCapacityHours, maxConcurrentTasks, isAvailable, currentFocus } = req.body;

    const profile = await developerStore.upsertDeveloperProfile(project.id, targetUserId, {
      declaredSkills,
      weeklyCapacityHours,
      maxConcurrentTasks,
      isAvailable,
      currentFocus
    });

    return res.json({ profile });
  } catch (err) {
    const status = err.status || (
      err.message.includes('requires') || err.message.includes('not a member') ? 403 :
      err.message.includes('cookie') ? 401 : 400
    );
    return res.status(status).json({ error: err.message });
  }
});

/**
 * POST /api/pm/assignment/recommendations
 * Deterministic developer assignment intelligence.
 * Strictly advisory recommendations: no auto-assignments occur.
 */
router.post('/recommendations', async (req, res) => {
  try {
    const { project, authUser, owner, repo } = await getOrCreateProjectAndAuthorize(req, 'Viewer');

    // Decrypt GitHub token for fetching GitHub evidence
    let githubToken = null;
    if (authUser.encrypted_token && authUser.token_iv) {
      githubToken = decryptToken(authUser.encrypted_token, authUser.token_iv);
    }

    // 1. Fetch eligible repository assignees from GitHub API
    const { assignees: eligibleAssignees, warning: assigneeWarning } = 
      await githubEvidence.fetchEligibleAssignees(owner, repo, githubToken);

    if (!eligibleAssignees || eligibleAssignees.length === 0) {
      return res.json({
        recommendations: [],
        warnings: [assigneeWarning || 'No eligible assignees found for this repository on GitHub.'],
        metadata: {
          evaluatedCandidatesCount: 0,
          task: req.body.task || {},
          hasToken: Boolean(githubToken)
        }
      });
    }

    // 2. Fetch all declared profiles in this project
    const profiles = await developerStore.listProjectDeveloperProfiles(project.id);
    const profileByUsername = {};
    for (const p of profiles) {
      profileByUsername[(p.github_username || '').toLowerCase()] = p;
    }

    // 3. Collect GitHub activity evidence for eligible assignees
    const assigneeUsernames = eligibleAssignees.map(a => a.username);
    const { evidenceByUser, warnings: evidenceWarnings } = 
      await githubEvidence.collectRepositoryEvidence(owner, repo, githubToken, assigneeUsernames);

    // 4. Assemble candidate records (strictly eligible assignees only)
    const candidates = eligibleAssignees.map(assignee => {
      const usernameLower = assignee.username.toLowerCase();
      return {
        username: assignee.username,
        githubId: assignee.githubId,
        avatarUrl: assignee.avatarUrl,
        profile: profileByUsername[usernameLower] || null,
        githubEvidence: evidenceByUser[usernameLower] || null
      };
    });

    // 5. Score candidates deterministically
    const taskInput = req.body.task || {
      title: req.body.title || '',
      description: req.body.description || '',
      requiredSkills: req.body.requiredSkills || [],
      estimatedHours: req.body.estimatedHours || 8,
      priority: req.body.priority || 'Medium',
      risk: req.body.risk || 'Low'
    };

    const recommendations = assignmentEngine.calculateAssignmentRecommendations({
      candidates,
      task: taskInput
    });

    const allWarnings = [];
    if (assigneeWarning) allWarnings.push(assigneeWarning);
    allWarnings.push(...evidenceWarnings);

    return res.json({
      recommendations,
      warnings: allWarnings,
      metadata: {
        evaluatedCandidatesCount: candidates.length,
        task: taskInput,
        generatedAt: new Date().toISOString()
      }
    });
  } catch (err) {
    const status = err.status || (
      err.message.includes('not a member') || err.message.includes('requires') ? 403 :
      err.message.includes('cookie') ? 401 : 500
    );
    return res.status(status).json({ error: err.message });
  }
});

export default router;
