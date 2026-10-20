import express from 'express';
import { authenticateRequest, authorizeProjectAction, decryptToken, getProjectRole, setProjectRole } from '../../lib/auth.js';
import { RELAY_ORIGIN, header, hasOrigin, corsHeaders } from '../../lib/assistant-access.js';
import developerStore from '../../lib/developer-store.js';
import projectStore from '../../lib/project-store.js';
import memberStore from '../../lib/member-store.js';
import githubEvidence from '../../lib/github-evidence.js';
import assignmentEngine from '../../lib/assignment-engine.js';
import assignmentPolicyStore from '../../lib/assignment-policy-store.js';
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
 * GET /api/pm/assignment/policy
 * Get project assignment policy configuration.
 */
router.get('/policy', async (req, res) => {
  try {
    const { project } = await getOrCreateProjectAndAuthorize(req, 'Viewer');
    const policy = await assignmentPolicyStore.getAssignmentPolicy(project.id);
    return res.json({ policy });
  } catch (err) {
    const status = err.status || (
      err.message.includes('not a member') ? 403 :
      err.message.includes('cookie') ? 401 : 500
    );
    return res.status(status).json({ error: err.message });
  }
});

/**
 * PUT /api/pm/assignment/policy
 * Update project assignment policy configuration. Requires Manager or Approver role.
 */
router.put('/policy', async (req, res) => {
  try {
    const { project, authUser } = await getOrCreateProjectAndAuthorize(req, 'Manager');
    const { mode, minConfidenceScore, enforceCapacityLimits, allowGrowthAllocation } = req.body || {};

    const policy = await assignmentPolicyStore.updateAssignmentPolicy(project.id, authUser.id, {
      mode,
      minConfidenceScore,
      enforceCapacityLimits,
      allowGrowthAllocation
    });

    return res.json({ policy });
  } catch (err) {
    const status = err.status || (
      err.message.includes('requires') || err.message.includes('not a member') ? 403 :
      err.message.includes('cookie') ? 401 : 400
    );
    return res.status(status).json({ error: err.message });
  }
});

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
 * Strictly advisory recommendations: no auto-assignments occur on this endpoint.
 */
router.post('/recommendations', async (req, res) => {
  try {
    const { project, authUser, owner, repo } = await getOrCreateProjectAndAuthorize(req, 'Viewer');

    // Decrypt GitHub token for fetching GitHub evidence
    let githubToken = null;
    if (authUser.encrypted_token && authUser.token_iv) {
      githubToken = decryptToken(authUser.encrypted_token, authUser.token_iv);
    }

    // 0. Fetch candidate project members to verify membership
    const candidateMembers = await memberStore.getMembers(project.id).catch(() => []);

    // 1. Fetch eligible repository assignees from GitHub API
    const { assignees: eligibleAssignees, warning: assigneeWarning } = 
      await githubEvidence.fetchEligibleAssignees(owner, repo, githubToken, candidateMembers);

    const policy = await assignmentPolicyStore.getAssignmentPolicy(project.id);

    if (!eligibleAssignees || eligibleAssignees.length === 0) {
      return res.json({
        recommendations: [],
        warnings: [assigneeWarning || 'No eligible assignees found for this repository on GitHub.'],
        policy,
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
      policy,
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

/**
 * POST /api/pm/assignment/assign
 * Execute an assignment on an existing GitHub issue.
 * Supports manual approval and explicit override with audit tracking.
 */
router.post('/assign', async (req, res) => {
  try {
    const { project, authUser, owner, repo } = await getOrCreateProjectAndAuthorize(req, 'Manager');

    const { issueNumber, assignee, mode = 'manual_approval', isOverride = false } = req.body || {};
    const num = Number(issueNumber);
    if (!num || isNaN(num) || num <= 0) {
      return res.status(400).json({ error: 'Valid positive issueNumber is required' });
    }
    if (!assignee || typeof assignee !== 'string' || !assignee.trim()) {
      return res.status(400).json({ error: 'assignee username is required' });
    }
    const cleanAssignee = assignee.trim();

    // Decrypt GitHub token
    let githubToken = null;
    if (authUser.encrypted_token && authUser.token_iv) {
      githubToken = decryptToken(authUser.encrypted_token, authUser.token_iv);
    }
    if (!githubToken) {
      return res.status(403).json({ error: 'GitHub authentication token required to update issue assignees' });
    }

    // Call GitHub REST API to assign issue
    const assignUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${num}/assignees`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    const ghRes = await fetch(assignUrl, {
      method: 'POST',
      headers: {
        'Accept': 'application/vnd.github.v3+json',
        'Authorization': `Bearer ${githubToken}`,
        'Content-Type': 'application/json',
        'User-Agent': 'Relay-App'
      },
      body: JSON.stringify({ assignees: [cleanAssignee] }),
      signal: controller.signal
    }).catch(err => {
      clearTimeout(timeoutId);
      throw new Error(`GitHub network request failed: ${err.message}`);
    });
    clearTimeout(timeoutId);

    if (!ghRes.ok) {
      let errText = `GitHub API error: ${ghRes.status}`;
      try {
        const ghData = await ghRes.json();
        if (ghData.message) errText += ` - ${ghData.message}`;
      } catch {}

      await assignmentPolicyStore.recordExecution({
        projectId: project.id,
        issueNumber: num,
        githubIssueUrl: `https://github.com/${owner}/${repo}/issues/${num}`,
        assignee: cleanAssignee,
        mode: isOverride ? 'manual_override' : mode,
        status: 'failed',
        errorMessage: errText,
        userId: authUser.id
      });

      return res.status(ghRes.status === 404 ? 404 : (ghRes.status === 403 ? 403 : 400)).json({
        error: `Could not assign @${cleanAssignee} to issue #${num}: ${errText}`
      });
    }

    const ghData = await ghRes.json();
    const confirmedAssignees = (ghData.assignees || []).map(a => a.login);
    const issueUrl = ghData.html_url || `https://github.com/${owner}/${repo}/issues/${num}`;

    // Verify GitHub actually added the assignee (if user is ineligible, GitHub returns 200/201 but empty assignees)
    const assigneeLower = cleanAssignee.toLowerCase();
    const wasAssigned = confirmedAssignees.some(login => login.toLowerCase() === assigneeLower);

    if (!wasAssigned) {
      const notEligibleMsg = `@${cleanAssignee} is not an eligible collaborator or assignee for ${owner}/${repo} on GitHub.`;
      await assignmentPolicyStore.recordExecution({
        projectId: project.id,
        issueNumber: num,
        githubIssueUrl: issueUrl,
        assignee: cleanAssignee,
        mode: isOverride ? 'manual_override' : mode,
        status: 'failed',
        errorMessage: notEligibleMsg,
        userId: authUser.id
      });

      return res.status(422).json({
        error: notEligibleMsg,
        assignee: cleanAssignee,
        issueNumber: num,
        githubUrl: issueUrl
      });
    }

    // Record successful assignment execution
    await assignmentPolicyStore.recordExecution({
      projectId: project.id,
      issueNumber: num,
      githubIssueUrl: issueUrl,
      assignee: cleanAssignee,
      mode: isOverride ? 'manual_override' : mode,
      status: 'success',
      userId: authUser.id
    });

    return res.json({
      success: true,
      issueNumber: num,
      assignee: cleanAssignee,
      assigned: true,
      githubUrl: issueUrl,
      assignees: confirmedAssignees
    });
  } catch (err) {
    const status = err.status || (
      err.message.includes('requires') || err.message.includes('not a member') ? 403 :
      err.message.includes('cookie') ? 401 : 500
    );
    return res.status(status).json({ error: err.message });
  }
});

export default router;
