import db from './db.js';
import { getSessionUser } from './session.js';
import crypto from 'crypto';

export function parseCookies(req) {
  const list = {};
  const rc = typeof req.headers?.get === 'function' ? req.headers.get('cookie') : req.headers?.cookie;
  if (rc) {
    rc.split(';').forEach((cookie) => {
      const parts = cookie.split('=');
      const key = parts.shift().trim();
      const value = parts.join('=');
      if (key) {
        list[key] = decodeURIComponent(value);
      }
    });
  }
  return list;
}

export function decryptToken(encryptedTokenStr, tokenIvHex) {
  if (!encryptedTokenStr || !tokenIvHex) return null;
  const keyHex = process.env.TOKEN_ENCRYPTION_KEY;
  if (!keyHex) return null;
  const key = Buffer.from(keyHex, 'hex');
  if (key.length !== 32) return null;

  const parts = encryptedTokenStr.split(':');
  if (parts.length !== 2) return null;

  const encryptedText = parts[0];
  const authTag = Buffer.from(parts[1], 'hex');
  const iv = Buffer.from(tokenIvHex, 'hex');

  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
    decrypted += decipher.final('utf8');

    return decrypted;
  } catch (err) {
    return null;
  }
}

export async function verifyGitHubToken(token) {
  if (!token) {
    throw new Error('Missing GitHub token');
  }

  const response = await fetch('https://api.github.com/user', {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': 'Relay-Backend'
    }
  });

  if (!response.ok) {
    throw new Error('Invalid or expired GitHub token');
  }

  const data = await response.json();
  if (!data.id || !data.login) {
    throw new Error('Incomplete GitHub user profile returned');
  }

  return {
    githubId: String(data.id),
    username: data.login
  };
}

export async function upsertUser(githubId, username, encryptedToken = null, tokenIv = null) {
  const res = await db.query(
    `INSERT INTO pm_users (github_id, github_username, encrypted_token, token_iv)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (github_id)
     DO UPDATE SET
        github_username = EXCLUDED.github_username,
        encrypted_token = COALESCE(EXCLUDED.encrypted_token, pm_users.encrypted_token),
        token_iv = COALESCE(EXCLUDED.token_iv, pm_users.token_iv),
        updated_at = now()
     RETURNING *`,
    [githubId, username, encryptedToken, tokenIv]
  );
  return res.rows[0];
}

export async function authenticateRequest(req) {
  const cookies = parseCookies(req);
  const sessionId = cookies['relay_pm_session'];

  if (!sessionId) {
    throw new Error('Missing session cookie');
  }

  // Use session id to get user
  const user = await getSessionUser(sessionId);
  return user;
}

export async function getProjectRole(projectId, userId) {
  const res = await db.query(
    `SELECT role FROM pm_project_members WHERE project_id = $1 AND user_id = $2`,
    [projectId, userId]
  );
  if (res.rows.length === 0) return null;
  return res.rows[0].role;
}

export async function setProjectRole(projectId, userId, role) {
  const res = await db.query(
    `INSERT INTO pm_project_members (project_id, user_id, role)
     VALUES ($1, $2, $3)
     ON CONFLICT (project_id, user_id)
     DO UPDATE SET role = EXCLUDED.role, updated_at = now()
     RETURNING *`,
    [projectId, userId, role]
  );
  return res.rows[0];
}

export async function authorizeProjectAction(req, projectId, requiredRole) {
  const user = await authenticateRequest(req);
  const role = await getProjectRole(projectId, user.id);

  if (!role) {
    throw new Error('User is not a member of this project');
  }

  const roleHierarchy = {
    'Viewer': 1,
    'Manager': 2,
    'Approver': 3
  };

  const userLevel = roleHierarchy[role];
  const requiredLevel = roleHierarchy[requiredRole];

  if (userLevel === undefined) {
    throw new Error(`Invalid or unrecognized project role: ${role}`);
  }
  if (requiredLevel === undefined) {
    throw new Error(`Unknown required role: ${requiredRole}`);
  }

  if (userLevel < requiredLevel) {
    throw new Error(`Action requires ${requiredRole} role, but user is ${role}`);
  }

  return user;
}
