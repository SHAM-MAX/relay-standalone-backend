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
  if (!context || !context.owner || !context.repository) {
    return res.status(400).json({ error: 'Missing or invalid context (owner, repository required).', code: 'INVALID_CONTEXT' });
  }
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

  let project = await projectStore.getProject(context.owner, context.repository);
  if (!project) {
    project = await projectStore.upsertProject({
      owner: context.owner,
      repository: context.repository,
      description: null
    });
  }

  // Create batch hash for requirement idempotency
  const batchHash = crypto.createHash('sha256').update(JSON.stringify(issuePlan.issues.map(i => i.title))).digest('hex');
  const requirement = await traceabilityStore.createRequirement(project.id, `Generated Issues Batch`, 'Auto-generated requirement for issue batch', 'approved', batchHash);

  const results = [];

  for (const issue of issuePlan.issues) {
    const { title, body: issueBody, labels, issue_type, id: issueId } = issue;

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
      const url = `https://api.github.com/repos/${context.owner}/${context.repository}/issues`;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000); // 10s timeout

      const githubRes = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          title,
          body: issueBody || '',
          labels: Array.isArray(labels) ? labels : []
        }),
        signal: controller.signal
      });
      clearTimeout(timeoutId);

      if (!githubRes.ok) {
          const errorData = await githubRes.text();
          results.push({ title, status: 'error', error: `GitHub API error: ${githubRes.status} ${errorData}` });
          continue;
      }

      const data = await githubRes.json();

      if (workItem) {
        await traceabilityStore.updateWorkItemGitHubLink(workItem.id, data.number, data.html_url);
      }

      results.push({
          title: data.title,
          number: data.number,
          url: data.html_url,
          status: 'success'
      });
    } catch (err) {
      console.error(err);
      if (err.name === 'AbortError' || err.message.includes('timeout')) {
        results.push({ title, status: 'error', error: 'Network timeout. Issue may have been created on GitHub. Outcome uncertain.' });
      } else {
        results.push({ title, status: 'error', error: err.message });
      }
    }
  }

  return res.json({ results });
}
