
import { RELAY_ORIGIN, header, hasOrigin, corsHeaders, isJSON } from '../../lib/assistant-access.js';

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

  const token = process.env.GITHUB_TOKEN || process.env.GITHUB_PAT;
  if (!token) {
    return res.status(500).json({ error: 'GitHub token not configured on server.', code: 'NO_TOKEN' });
  }

  const headers = {
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': 'Relay-App',
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json'
  };

  const results = [];
  
  for (const issue of issuePlan.issues) {
    const { title, body: issueBody, labels } = issue;
    
    if (!title) {
        results.push({ title: title || 'Untitled', status: 'error', error: 'Missing title' });
        continue;
    }

    try {
      const url = `https://api.github.com/repos/${context.owner}/${context.repository}/issues`;
      const githubRes = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          title,
          body: issueBody || '',
          labels: Array.isArray(labels) ? labels : []
        })
      });

      if (!githubRes.ok) {
          const errorData = await githubRes.text();
          results.push({ title, status: 'error', error: `GitHub API error: ${githubRes.status} ${errorData}` });
          continue;
      }

      const data = await githubRes.json();
      results.push({
          title: data.title,
          number: data.number,
          url: data.html_url,
          status: 'success'
      });
    } catch (err) {
      console.error(err);
      results.push({ title, status: 'error', error: err.message });
    }
  }

  return res.json({ results });
}
