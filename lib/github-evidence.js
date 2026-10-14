/**
 * Module for collecting repository assignees and GitHub activity evidence.
 * Safely tolerates permission restrictions and rate-limiting.
 */

/**
 * Fetch list of valid assignees for a given repository.
 */
export async function fetchEligibleAssignees(owner, repo, githubToken) {
  const headers = {
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': 'Relay-App'
  };
  if (githubToken) {
    headers['Authorization'] = `Bearer ${githubToken}`;
  }

  // 1. Direct repository assignees endpoint (authoritative list of eligible assignees)
  const assigneesUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/assignees?per_page=100`;
  try {
    const res = await fetch(assigneesUrl, { headers, signal: AbortSignal.timeout(5000) });
    if (!res.ok) {
      const scopesHeader = (res.headers && typeof res.headers.get === 'function') ? (res.headers.get('x-oauth-scopes') || '') : '';
      const grantedScopes = scopesHeader.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
      const hasRepoScope = grantedScopes.includes('repo') || grantedScopes.includes('public_repo');

      let warning = `GitHub assignees query returned HTTP ${res.status}.`;
      if (res.status === 401 || res.status === 403) {
        if (scopesHeader !== '' && !hasRepoScope) {
          warning = `Insufficient GitHub permissions or OAuth scope to read repository assignees (HTTP ${res.status}). Granted scopes: [${grantedScopes.join(', ')}]. Reconnect Relay to grant public_repo or repo scope.`;
        } else {
          warning = `Insufficient GitHub permissions or OAuth scope to read repository assignees (HTTP ${res.status}).`;
        }
      } else if (res.status === 404) {
        warning = `Repository ${owner}/${repo} not found or inaccessible with current credentials (HTTP 404).`;
      }

      // Safe fallback: check if repo owner is assignable via GET /repos/{owner}/{repo}/assignees/{owner}
      try {
        const checkOwnerUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/assignees/${encodeURIComponent(owner)}`;
        const checkRes = await fetch(checkOwnerUrl, { headers, signal: AbortSignal.timeout(4000) });
        if (checkRes.status === 204) {
          return {
            assignees: [{ githubId: `owner-${owner}`, username: owner, avatarUrl: null }],
            warning: `${warning} Fallback to verified repository owner @${owner}.`
          };
        }
      } catch {
        // Fallback check failed, proceed with empty assignees
      }

      return { assignees: [], warning };
    }
    const data = await res.json();
    if (!Array.isArray(data)) {
      return { assignees: [], warning: 'Unexpected GitHub assignees payload' };
    }
    const assignees = data.map(item => ({
      githubId: String(item.id),
      username: item.login,
      avatarUrl: item.avatar_url || null
    }));

    return { assignees, warning: null };
  } catch (err) {
    return { assignees: [], warning: `Failed to fetch repo assignees: ${err.message}` };
  }
}

/**
 * Collect GitHub evidence for eligible assignees:
 * - Open assigned issues in repository
 * - Recent commits / contributions
 */
export async function collectRepositoryEvidence(owner, repo, githubToken, assigneeUsernames = []) {
  const headers = {
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': 'Relay-App'
  };
  if (githubToken) {
    headers['Authorization'] = `Bearer ${githubToken}`;
  }

  const evidenceByUser = {};
  const warnings = [];

  for (const username of assigneeUsernames) {
    evidenceByUser[username.toLowerCase()] = {
      openAssignedIssuesCount: 0,
      openAssignedIssues: [],
      recentCommitsCount: 0,
      recentPrsCount: 0,
      evidenceMissing: false
    };
  }

  // 1. Fetch open issues in the repository
  try {
    const issuesUrl = `https://api.github.com/repos/${owner}/${repo}/issues?state=open&per_page=100`;
    const res = await fetch(issuesUrl, { headers, signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      const issues = await res.json();
      if (Array.isArray(issues)) {
        for (const issue of issues) {
          // Check assignees
          const issueAssignees = issue.assignees || (issue.assignee ? [issue.assignee] : []);
          for (const a of issueAssignees) {
            const login = (a.login || '').toLowerCase();
            if (evidenceByUser[login]) {
              evidenceByUser[login].openAssignedIssuesCount += 1;
              if (evidenceByUser[login].openAssignedIssues.length < 5) {
                evidenceByUser[login].openAssignedIssues.push({
                  number: issue.number,
                  title: issue.title,
                  isPullRequest: Boolean(issue.pull_request)
                });
              }
            }
          }
        }
      }
    } else {
      warnings.push(`Open issues query returned HTTP ${res.status}`);
    }
  } catch (err) {
    warnings.push(`Could not fetch repository open issues: ${err.message}`);
  }

  // 2. Fetch contributors / commits for familiarity signal
  try {
    const contribsUrl = `https://api.github.com/repos/${owner}/${repo}/contributors?per_page=100`;
    const res = await fetch(contribsUrl, { headers, signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      const contribs = await res.json();
      if (Array.isArray(contribs)) {
        for (const c of contribs) {
          const login = (c.login || '').toLowerCase();
          if (evidenceByUser[login]) {
            evidenceByUser[login].recentCommitsCount = c.contributions || 0;
          }
        }
      }
    } else {
      warnings.push(`Contributors query returned HTTP ${res.status}`);
    }
  } catch (err) {
    warnings.push(`Could not fetch repository contributors: ${err.message}`);
  }

  return { evidenceByUser, warnings };
}

export default {
  fetchEligibleAssignees,
  collectRepositoryEvidence
};
