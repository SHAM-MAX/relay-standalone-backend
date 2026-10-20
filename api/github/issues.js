import { RELAY_ORIGIN, header, hasOrigin, corsHeaders, isJSON } from '../../lib/assistant-access.js';
import projectStore from '../../lib/project-store.js';
import traceabilityStore from '../../lib/traceability-store.js';
import { authenticateRequest, decryptToken } from '../../lib/auth.js';
import crypto from 'node:crypto';

export const access = 'public';
export const methods = ['POST', 'OPTIONS'];

export default async function (req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Vary', 'Origin');

  const origin = header(req, 'origin');
  const approvedOrigin = origin === RELAY_ORIGIN || await hasOrigin(origin);

  if (approvedOrigin) corsHeaders(res, origin);

  if (req.method === 'OPTIONS') {
    const requestedHeaders = String(header(req, 'access-control-request-headers') || '').toLowerCase().split(',').map(value => value.trim()).filter(Boolean);
    if (!approvedOrigin || header(req, 'access-control-request-method') !== 'POST' || requestedHeaders.some(value => value !== 'content-type')) {
      return res.status(403).json({ error: 'This extension origin or preflight is not allowed.', code: 'ORIGIN_NOT_ALLOWED' });
    }
    return res.status(204).send('');
  }

  if (!approvedOrigin) {
    return res.status(403).json({ error: 'Use Connect Relay in the panel to approve this extension.', code: 'EXTENSION_NOT_CONNECTED' });
  }

  if (!isJSON(req)) {
    return res.status(415).json({ error: 'Send application/json.', code: 'INVALID_CONTENT_TYPE' });
  }

  let body;
  try {
    body = req.body;
  } catch (err) {
    return res.status(400).json({ error: 'Invalid JSON', code: 'INVALID_JSON' });
  }

  const { context, issuePlan } = body;
  if (!context || typeof context !== 'object') {
    return res.status(400).json({ error: 'Missing or invalid context (owner, repository required).', code: 'INVALID_CONTEXT' });
  }

  // Robustly extract and normalize owner and repository
  let rawOwner = typeof context.owner === 'string' ? context.owner.trim() : '';
  let rawRepo = typeof context.repository === 'string' ? context.repository.trim() : '';

  // Handle cases where repository is passed as "owner/repo" or contains slashes
  if (rawRepo.includes('/')) {
    const parts = rawRepo.split('/').map(p => p.trim()).filter(Boolean);
    if (parts.length >= 2) {
      if (!rawOwner) rawOwner = parts[0];
      rawRepo = parts[parts.length - 1];
    } else if (parts.length === 1) {
      rawRepo = parts[0];
    }
  }

  // Strip any trailing .git or leading/trailing slashes
  rawRepo = rawRepo.replace(/\.git$/i, '').replace(/^\/+|\/+$/g, '');
  rawOwner = rawOwner.replace(/^\/+|\/+$/g, '');

  if (!rawOwner || !rawRepo || !/^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i.test(rawOwner) || !/^[\w.-]{1,100}$/.test(rawRepo)) {
    return res.status(400).json({ error: 'Missing or invalid context (owner, repository required).', code: 'INVALID_CONTEXT' });
  }

  const normalizedOwner = rawOwner;
  const normalizedRepo = rawRepo;

  if (!issuePlan || !Array.isArray(issuePlan.issues) || issuePlan.issues.length === 0) {
    return res.status(400).json({ error: 'Missing or empty issuePlan.', code: 'INVALID_ISSUE_PLAN' });
  }

  let user;
  try {
    user = await authenticateRequest(req);
  } catch (e) {
    return res.status(401).json({ error: 'Authentication failed.', code: 'UNAUTHORIZED' });
  }

  if (!user || !user.encrypted_token || !user.token_iv) {
    return res.status(401).json({ error: 'Missing GitHub token. Reconnect your account.', code: 'MISSING_GITHUB_TOKEN' });
  }

  const token = decryptToken(user.encrypted_token, user.token_iv);
  if (!token) {
    return res.status(401).json({ error: 'Invalid GitHub token. Reconnect your account.', code: 'INVALID_GITHUB_TOKEN' });
  }

  const headers = {
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': 'Relay-App',
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json'
  };

  let project = await projectStore.getProject(normalizedOwner, normalizedRepo);
  if (!project) {
    project = await projectStore.upsertProject({
      owner: normalizedOwner,
      repository: normalizedRepo,
      description: null
    });
  }

  // Create batch hash for requirement idempotency
  const batchHash = crypto.createHash('sha256').update(JSON.stringify(issuePlan.issues.map(i => i.title))).digest('hex');
  const requirement = await traceabilityStore.createRequirement(project.id, `Generated Issues Batch`, 'Auto-generated requirement for issue batch', 'approved', batchHash);

  const results = [];

  for (const issue of issuePlan.issues) {
    const { title, body: issueBody, labels, issue_type, id: issueId, assignees, assignee } = issue;

    if (!title) {
        results.push({ title: title || 'Untitled', status: 'error', error: 'Missing title' });
        continue;
    }

    const clientRefId = issueId || crypto.createHash('sha256').update(title + (issueBody||'')).digest('hex');

    let workItem = null;
    try {
      const type = ['user_story', 'bug', 'task', 'change_request'].includes(issue_type) ? issue_type : 'task';
      workItem = await traceabilityStore.createWorkItem(project.id, requirement.id, type, title, issueBody || '', 'draft', clientRefId);
    } catch (err) {
      console.error('Failed to create work item:', err);
    }

    if (workItem && workItem.status === 'published' && workItem.github_issue_number) {
      results.push({
          title,
          number: workItem.github_issue_number,
          url: workItem.github_issue_url,
          status: 'success'
      });
      continue;
    }

    try {
      const url = `https://api.github.com/repos/${encodeURIComponent(normalizedOwner)}/${encodeURIComponent(normalizedRepo)}/issues`;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000); // 10s timeout

      // Normalize assignees array (support single assignee string or assignees array)
      let resolvedAssignees = [];
      if (Array.isArray(assignees)) {
        resolvedAssignees = assignees.filter(a => typeof a === 'string' && a.trim().length > 0);
      } else if (typeof assignee === 'string' && assignee.trim().length > 0) {
        resolvedAssignees = [assignee.trim()];
      }

      const issuePayload = {
        title,
        body: issueBody || '',
        labels: Array.isArray(labels) ? labels : []
      };
      if (resolvedAssignees.length > 0) {
        issuePayload.assignees = resolvedAssignees;
      }

      const githubRes = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(issuePayload),
        signal: controller.signal
      });
      clearTimeout(timeoutId);

      if (!githubRes.ok) {
          let errorMsg = `GitHub API error: ${githubRes.status}`;
          if (githubRes.status === 404) {
            // Safe diagnostic distinction without logging tokens or secrets
            const grantedScopesHeader = githubRes.headers.get('x-oauth-scopes') || '';
            const grantedScopes = grantedScopesHeader.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
            const hasIssueScope = grantedScopes.includes('repo') || grantedScopes.includes('public_repo');

            if (grantedScopesHeader !== '' && !hasIssueScope) {
              errorMsg = `GitHub token is missing issue creation scope (granted: [${grantedScopes.join(', ')}]). Please log out and reconnect Relay to grant public_repo scope (HTTP 404).`;
            } else {
              // Check if repo is visible and check collaborator/access signals using a safe GET
              try {
                const checkRepoUrl = `https://api.github.com/repos/${encodeURIComponent(normalizedOwner)}/${encodeURIComponent(normalizedRepo)}`;
                const repoRes = await fetch(checkRepoUrl, { headers });
                if (repoRes.status === 404) {
                  errorMsg = `GitHub repository ${normalizedOwner}/${normalizedRepo} not found or not accessible with current credentials (HTTP 404).`;
                } else if (repoRes.ok) {
                  const repoData = await repoRes.json();
                  const canPush = repoData.permissions ? repoData.permissions.push : null;
                  if (canPush === false) {
                    errorMsg = `GitHub account has restricted or read-only access (push permission is false) on ${normalizedOwner}/${normalizedRepo} (HTTP 404).`;
                  } else if (grantedScopesHeader !== '' && !hasIssueScope) {
                    errorMsg = `GitHub token is missing issue creation scope (granted: [${grantedScopes.join(', ')}]). Please log out and reconnect Relay (HTTP 404).`;
                  } else {
                    errorMsg = `GitHub repository ${normalizedOwner}/${normalizedRepo} returned 404 on issue creation. Verify repository exists and user has issue creation permissions (HTTP 404).`;
                  }
                } else {
                  errorMsg = `GitHub repository ${normalizedOwner}/${normalizedRepo} returned HTTP ${repoRes.status} during verification.`;
                }
              } catch {
                errorMsg = `GitHub repository ${normalizedOwner}/${normalizedRepo} not found or insufficient permissions to create issues (HTTP 404).`;
              }
            }
          } else if (githubRes.status === 403 || githubRes.status === 401) {
            errorMsg = `GitHub permission denied or token expired (HTTP ${githubRes.status}). Reconnect your GitHub account.`;
          } else {
            try {
              const errorText = await githubRes.text();
              try {
                const parsed = JSON.parse(errorText);
                if (parsed && parsed.message) {
                  errorMsg = `GitHub API error: ${parsed.message} (HTTP ${githubRes.status})`;
                }
              } catch {
                if (errorText && errorText.length < 200) {
                  errorMsg = `GitHub API error: ${githubRes.status} ${errorText.trim()}`;
                }
              }
            } catch {
              // Ignore body read failure
            }
          }
          results.push({ title, status: 'error', error: errorMsg });
          continue;
      }

      const data = await githubRes.json();

      if (workItem) {
        await traceabilityStore.updateWorkItemGitHubLink(workItem.id, data.number, data.html_url);
      }

      const confirmedAssignees = (data.assignees || []).map(a => a.login);
      let assignmentStatus = null;
      if (resolvedAssignees.length > 0) {
        const primaryRequested = resolvedAssignees[0].toLowerCase();
        const matched = confirmedAssignees.some(l => l.toLowerCase() === primaryRequested);
        if (matched) {
          assignmentStatus = { assigned: true, assignees: confirmedAssignees };
        } else {
          assignmentStatus = {
            assigned: false,
            warning: `@${resolvedAssignees[0]} was requested but could not be assigned (not a repository collaborator or lacks permissions).`
          };
        }
      }

      results.push({
          title: data.title,
          number: data.number,
          url: data.html_url,
          status: 'success',
          assignees: confirmedAssignees,
          assignment: assignmentStatus
      });
    } catch (err) {
      console.error(err);
      if (err.name === 'AbortError' || (err.message && err.message.includes('timeout'))) {
        results.push({ title, status: 'error', error: 'Network timeout. Issue may have been created on GitHub. Outcome uncertain.' });
      } else {
        results.push({ title, status: 'error', error: err.message || 'Unknown network error' });
      }
    }
  }

  return res.json({ results });
}
