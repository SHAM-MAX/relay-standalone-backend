import { RELAY_ORIGIN, header, hasOrigin, corsHeaders, isJSON } from '../../lib/assistant-access.js';
import { authenticateRequest, decryptToken } from '../../lib/auth.js';
import projectStore from '../../lib/project-store.js';
import traceabilityStore from '../../lib/traceability-store.js';
import traceabilityEngine from '../../lib/traceability-engine.js';

export default async function (req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Vary', 'Origin');

  const origin = header(req, 'origin');
  const approvedOrigin = origin === RELAY_ORIGIN || await hasOrigin(origin);

  if (approvedOrigin) corsHeaders(res, origin, 'GET, OPTIONS');

  if (req.method === 'OPTIONS') {
    return res.status(204).send('');
  }

  if (origin && !approvedOrigin) {
    return res.status(403).json({ error: 'Use Connect Relay in the panel to approve this extension.', code: 'EXTENSION_NOT_CONNECTED' });
  }

  let rawOwner = (req.query.owner || '').toString().trim();
  let rawRepo = (req.query.repo || '').toString().trim();

  if (rawRepo.includes('/')) {
    const parts = rawRepo.split('/').map(p => p.trim()).filter(Boolean);
    if (parts.length >= 2) {
      if (!rawOwner) rawOwner = parts[0];
      rawRepo = parts[parts.length - 1];
    } else if (parts.length === 1) {
      rawRepo = parts[0];
    }
  }

  const owner = rawOwner.replace(/^\/+|\/+$/g, '');
  const repo = rawRepo.replace(/\.git$/i, '').replace(/^\/+|\/+$/g, '');

  if (!owner || !repo) {
    return res.status(400).json({ error: 'Missing owner or repo query parameters', code: 'INVALID_REQUEST' });
  }

  try {
    let project = await projectStore.getProject(owner, repo);
    if (!project) {
      project = await projectStore.upsertProject({
        owner,
        repository: repo,
        description: null
      });
    }

    const rawTraceability = await traceabilityStore.getTraceability(project.id);

    // Optional user authentication for decrypting GitHub token (to query private repos and CI status)
    let githubToken = null;
    try {
      const authUser = await authenticateRequest(req);
      if (authUser?.encrypted_token && authUser?.token_iv) {
        githubToken = decryptToken(authUser.encrypted_token, authUser.token_iv);
      }
    } catch (_) {
      // Unauthenticated or session expired; will attempt public repository access
    }

    const headers = {
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'Relay-App'
    };
    if (githubToken) {
      headers['Authorization'] = `Bearer ${githubToken}`;
    }

    const warnings = [];

    // 1. Fetch live GitHub issues (up to 100)
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

    // 2. Fetch live GitHub pull requests (up to 100)
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

    // 3. For PRs, query commit status for test/CI verification evidence
    for (const pr of githubPulls.slice(0, 15)) {
      if (pr.head && pr.head.sha) {
        try {
          const statusUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(pr.head.sha)}/status`;
          const statusRes = await fetch(statusUrl, { headers, signal: AbortSignal.timeout(3000) });
          if (statusRes.ok) {
            const statusData = await statusRes.json();
            pr.ciStatus = statusData.state; // 'success', 'failure', 'pending', etc.
          }
        } catch (_) {
          // Status check is optional/best effort
        }
      }
    }

    // 4. Run intelligence engine to build matrix, test verification, and delivery gaps
    const matrixResult = traceabilityEngine.buildTraceabilityMatrix(rawTraceability, githubIssues, githubPulls);

    return res.json({
      traceability: matrixResult.requirements,
      gaps: matrixResult.gaps,
      summary: matrixResult.summary,
      rawTraceability,
      warnings
    });
  } catch (error) {
    return res.status(500).json({ error: error.message, code: 'INTERNAL_ERROR' });
  }
}

