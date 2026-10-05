
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

  try {
    const token = process.env.GITHUB_TOKEN || process.env.GITHUB_PAT;
    const headers = { 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'Relay-App' };
    
    let url = 'https://api.github.com/user/repos?sort=updated&per_page=100';

    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    } else {
      // Fallback for local demo without token configured
      url = 'https://api.github.com/users/SHAM-MAX/repos?sort=updated&per_page=100';
    }

    const githubRes = await fetch(url, { headers });
    
    if (!githubRes.ok) {
        return res.status(githubRes.status).json({ error: 'GitHub API error' });
    }

    const data = await githubRes.json();
    return res.json({
      repositories: data.map(repo => ({
        id: repo.id,
        name: repo.name,
        fullName: repo.full_name,
        htmlUrl: repo.html_url,
        private: repo.private,
        owner: repo.owner.login,
        url: repo.html_url,
        context: {
            owner: repo.owner.login,
            repository: repo.name,
            url: repo.html_url
        }
      }))
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
}
