import express from 'express';
import { authenticateRequest, decryptToken, getProjectRole, setProjectRole } from '../../lib/auth.js';
import { RELAY_ORIGIN, header, hasOrigin, corsHeaders } from '../../lib/assistant-access.js';
import projectStore from '../../lib/project-store.js';
import developerStore from '../../lib/developer-store.js';
import scheduleEngine from '../../lib/schedule-engine.js';
import milestoneStore from '../../lib/milestone-store.js';
import riskStore from '../../lib/risk-store.js';
import changeStore from '../../lib/change-store.js';
import traceabilityStore from '../../lib/traceability-store.js';
import traceabilityEngine from '../../lib/traceability-engine.js';
import githubEvidence from '../../lib/github-evidence.js';
import projectHealthEngine from '../../lib/project-health-engine.js';
import pmReportsEngine from '../../lib/pm-reports-engine.js';

const router = express.Router();

router.use(async (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Vary', 'Origin');

  const origin = header(req, 'origin');
  const approvedOrigin = origin === RELAY_ORIGIN || await hasOrigin(origin);

  if (approvedOrigin) {
    corsHeaders(res, origin, 'GET, OPTIONS');
  }

  if (req.method === 'OPTIONS') {
    if (origin && !approvedOrigin) {
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

  const authUser = await authenticateRequest(req);

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
 * GET /api/pm/reports
 * Comprehensive PM Reports & Delivery Forecasting evaluation.
 */
router.get('/', async (req, res) => {
  try {
    const { project, authUser, owner, repo } = await getOrCreateProjectAndAuthorize(req, 'Viewer');

    let githubToken = null;
    if (authUser.encrypted_token && authUser.token_iv) {
      githubToken = decryptToken(authUser.encrypted_token, authUser.token_iv);
    }

    const headers = {
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'Relay-App'
    };
    if (githubToken) {
      headers['Authorization'] = `Bearer ${githubToken}`;
    }

    const warnings = [];

    // 1. Fetch real GitHub issues (open & closed, up to 100)
    let githubIssues = [];
    try {
      const issuesUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues?state=all&per_page=100`;
      const issuesRes = await fetch(issuesUrl, { headers, signal: AbortSignal.timeout(6000) });
      if (issuesRes.ok) {
        githubIssues = await issuesRes.json();
      } else {
        warnings.push(`GitHub issues query returned HTTP ${issuesRes.status}`);
      }
    } catch (err) {
      warnings.push(`Could not fetch GitHub issues: ${err.message}`);
    }

    // 2. Fetch real GitHub pull requests (open & closed, up to 100)
    let githubPulls = [];
    try {
      const pullsUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls?state=all&per_page=100`;
      const pullsRes = await fetch(pullsUrl, { headers, signal: AbortSignal.timeout(6000) });
      if (pullsRes.ok) {
        githubPulls = await pullsRes.json();
      } else {
        warnings.push(`GitHub pulls query returned HTTP ${pullsRes.status}`);
      }
    } catch (err) {
      warnings.push(`Could not fetch GitHub pull requests: ${err.message}`);
    }

    // 3. Fetch real GitHub milestones (open and closed, up to 100)
    let githubMilestones = [];
    try {
      const msUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/milestones?state=all&per_page=100`;
      const msRes = await fetch(msUrl, { headers, signal: AbortSignal.timeout(6000) });
      if (msRes.ok) {
        githubMilestones = await msRes.json();
      } else {
        warnings.push(`GitHub milestones query returned HTTP ${msRes.status}`);
      }
    } catch (err) {
      warnings.push(`Could not fetch GitHub milestones: ${err.message}`);
    }

    // 4. Optional CI check status on recent PRs
    for (const pr of githubPulls.slice(0, 10)) {
      if (pr.head && pr.head.sha) {
        try {
          const statusUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(pr.head.sha)}/status`;
          const statusRes = await fetch(statusUrl, { headers, signal: AbortSignal.timeout(3000) });
          if (statusRes.ok) {
            const statusData = await statusRes.json();
            pr.ciStatus = statusData.state;
          }
        } catch (_) {}
      }
    }

    // 5. Fetch Relay milestones, schedule items, risks, change requests, and traceability
    let relayMilestones = [];
    let scheduleItems = [];
    let risks = [];
    let changeRequests = [];
    let rawTraceability = [];

    try {
      relayMilestones = await milestoneStore.getMilestones(project.id);
    } catch (_) {}

    // Merge GitHub milestones and Relay milestones (deduplicating by title or clientReferenceId)
    const milestones = [...relayMilestones];
    const seenTitles = new Set(relayMilestones.map(m => (m.title || '').trim().toLowerCase()));

    for (const gm of githubMilestones) {
      const gmTitle = (gm.title || '').trim();
      const gmTitleLower = gmTitle.toLowerCase();
      if (!seenTitles.has(gmTitleLower)) {
        seenTitles.add(gmTitleLower);
        milestones.push({
          id: `gh-${gm.number || gm.id}`,
          milestone_id: `GH-${gm.number || gm.id}`,
          title: gmTitle,
          description: gm.description || '',
          target_date: gm.due_on ? gm.due_on.split('T')[0] : null,
          state: gm.state || 'open',
          source: 'github',
          html_url: gm.html_url
        });
      }
    }

    try {
      scheduleItems = await scheduleEngine.getSchedule(project.id);
    } catch (_) {}

    try {
      risks = await riskStore.getRisks(project.id);
    } catch (_) {}

    try {
      changeRequests = await changeStore.getChangeRequests(project.id);
    } catch (_) {}

    try {
      rawTraceability = await traceabilityStore.getTraceability(project.id);
    } catch (_) {}

    // 5. Developer profiles and workload evidence
    let developerProfiles = [];
    try {
      developerProfiles = await developerStore.listProjectDeveloperProfiles(project.id);
    } catch (_) {}

    const assigneeUsernames = developerProfiles.map(p => p.github_username).filter(Boolean);
    const { evidenceByUser, warnings: evidenceWarnings } = 
      await githubEvidence.collectRepositoryEvidence(owner, repo, githubToken, assigneeUsernames);
    if (evidenceWarnings) warnings.push(...evidenceWarnings);

    // 6. Calculate Health & Traceability Matrix using existing engines
    const healthAnalysis = projectHealthEngine.calculateProjectHealth({
      project: { owner, repository: repo },
      githubIssues,
      githubPulls,
      milestones,
      scheduleItems,
      developerProfiles,
      evidenceByUser,
      options: { stalledThresholdDays: 7 }
    });

    const traceabilityMatrix = traceabilityEngine.buildTraceabilityMatrix(
      rawTraceability,
      githubIssues,
      githubPulls
    );

    // 7. Synthesize PM Reports & Delivery Forecast
    const reports = pmReportsEngine.generatePmReports({
      project: { owner, repository: repo },
      githubIssues,
      githubPulls,
      milestones,
      scheduleItems,
      developerProfiles,
      evidenceByUser,
      healthAnalysis,
      traceabilityMatrix,
      risks,
      changeRequests
    });

    return res.json({
      reports,
      warnings,
      context: {
        owner,
        repo,
        projectId: project.id,
        hasGithubToken: Boolean(githubToken)
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
