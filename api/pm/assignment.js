import express from 'express';
import { authenticateRequest, authorizeProjectAction, decryptToken } from '../../lib/auth.js';
import developerStore from '../../lib/developer-store.js';
import projectStore from '../../lib/project-store.js';
import githubEvidence from '../../lib/github-evidence.js';
import assignmentEngine from '../../lib/assignment-engine.js';
import db from '../../lib/db.js';

const router = express.Router();

function getOwnerRepo(req) {
  const owner = req.query.owner || req.body?.owner;
  const repo = req.query.repo || req.body?.repo;
  return { owner, repo };
}

/**
 * GET /api/pm/assignment/profile
 * Get developer profile for current user or project members.
 */
router.get('/profile', async (req, res) => {
  try {
    const { owner, repo } = getOwnerRepo(req);
    if (!owner || !repo) {
      return res.status(400).json({ error: 'owner and repo query parameters are required' });
    }

    const project = await projectStore.getProject(owner, repo);
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    // Must be at least a Viewer of the project
    const authUser = await authorizeProjectAction(req, project.id, 'Viewer');

    // If targetUserId query param is passed and user is Manager/Approver, allow reading other's profile
    const targetUserId = req.query.userId || authUser.id;
    const profile = await developerStore.getDeveloperProfile(project.id, targetUserId);

    return res.json({ profile });
  } catch (err) {
    const status = err.message.includes('not a member') ? 403 : 
                   err.message.includes('cookie') ? 401 : 500;
    return res.status(status).json({ error: err.message });
  }
});

/**
 * PUT /api/pm/assignment/profile
 * Upsert developer profile for the user or by Manager/Approver for another user.
 */
router.put('/profile', async (req, res) => {
  try {
    const { owner, repo } = getOwnerRepo(req);
    if (!owner || !repo) {
      return res.status(400).json({ error: 'owner and repo are required' });
    }

    const project = await projectStore.getProject(owner, repo);
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    const authUser = await authenticateRequest(req);
    const targetUserId = req.body.userId || authUser.id;

    // If editing another user's profile, require Manager or Approver role
    if (targetUserId !== authUser.id) {
      await authorizeProjectAction(req, project.id, 'Manager');
    } else {
      await authorizeProjectAction(req, project.id, 'Viewer');
    }

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
    const status = err.message.includes('requires') || err.message.includes('not a member') ? 403 :
                   err.message.includes('cookie') ? 401 : 400;
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
    const { owner, repo } = getOwnerRepo(req);
    if (!owner || !repo) {
      return res.status(400).json({ error: 'owner and repo are required' });
    }

    const project = await projectStore.getProject(owner, repo);
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    // Must be authenticated and at least a Viewer of the project
    const authUser = await authorizeProjectAction(req, project.id, 'Viewer');

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
        warnings: [assigneeWarning || 'No eligible assignees found for this repository'],
        metadata: {
          evaluatedCandidatesCount: 0,
          task: req.body.task || {}
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
    const status = err.message.includes('not a member') || err.message.includes('requires') ? 403 :
                   err.message.includes('cookie') ? 401 : 500;
    return res.status(status).json({ error: err.message });
  }
});

export default router;
