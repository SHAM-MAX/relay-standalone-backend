import { RELAY_ORIGIN, header, hasOrigin, corsHeaders } from '../../lib/assistant-access.js';
import { authenticateRequest, decryptToken } from '../../lib/auth.js';

export const access = 'public';
export const methods = ['GET', 'OPTIONS'];

export default async function (req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Vary', 'Origin');

  const origin = header(req, 'origin');
  const approvedOrigin = origin === RELAY_ORIGIN || await hasOrigin(origin);

  if (approvedOrigin) corsHeaders(res, origin);

  if (req.method === 'OPTIONS') {
    const requestedHeaders = String(header(req, 'access-control-request-headers') || '').toLowerCase().split(',').map(value => value.trim()).filter(Boolean);
    if (!approvedOrigin || header(req, 'access-control-request-method') !== 'GET') {
      return res.status(403).json({ error: 'This extension origin or preflight is not allowed.', code: 'ORIGIN_NOT_ALLOWED' });
    }
    return res.status(204).send('');
  }

  if (origin && !approvedOrigin) {
    return res.status(403).json({ error: 'Use Connect Relay in the panel to approve this extension.', code: 'EXTENSION_NOT_CONNECTED' });
  }

  try {
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
      'Authorization': `Bearer ${token}`
    };

    const url = 'https://api.github.com/user/repos?sort=updated&per_page=100';

    const githubRes = await fetch(url, { headers });

    if (!githubRes.ok) {
      if (githubRes.status === 401 || githubRes.status === 403) {
        return res.status(githubRes.status).json({ error: 'GitHub authentication failed or rate limited.', code: 'GITHUB_API_ERROR' });
      }
      return res.status(githubRes.status).json({ error: 'GitHub API error', code: 'GITHUB_API_ERROR' });
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
