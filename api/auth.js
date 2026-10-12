import express from 'express';
import { createOAuthState, consumeOAuthState, createSession, revokeSession } from '../lib/session.js';
import { verifyGitHubToken, upsertUser, parseCookies } from '../lib/auth.js';
import db from '../lib/db.js';
import { hasOrigin, corsHeaders, header } from '../lib/assistant-access.js';
import crypto from 'crypto';

const router = express.Router();

router.use(async (req, res, next) => {
  const origin = header(req, 'origin');
  let approvedOrigin = await hasOrigin(origin);
  const isBootstrapAuth = req.path === '/github/login' || req.path === '/github/exchange';
  const expectedOrigin = process.env.RELAY_EXTENSION_ID ? `chrome-extension://${process.env.RELAY_EXTENSION_ID}` : null;

  if (isBootstrapAuth && expectedOrigin && origin === expectedOrigin) {
    approvedOrigin = true;
  }

  if (approvedOrigin) {
    corsHeaders(res, origin);
  }

  if (req.method === 'OPTIONS') {
    if (!approvedOrigin) return res.status(403).json({ error: 'Origin not allowed' });
    return res.status(204).send('');
  }
  if (origin && !approvedOrigin) {
    return res.status(403).json({ error: 'Origin not allowed' });
  }
  next();
});

function getEnvClientSecret() {
  const secret = process.env.GITHUB_CLIENT_SECRET;
  if (!secret) throw new Error('SERVER_CONFIG_ERROR');
  return secret;
}

function getEnvClientId() {
  const clientId = process.env.GITHUB_CLIENT_ID;
  if (!clientId) throw new Error('SERVER_CONFIG_ERROR');
  return clientId;
}

function getEnvRedirectUri() {
  const extId = process.env.RELAY_EXTENSION_ID;
  if (!extId) throw new Error('SERVER_CONFIG_ERROR');
  return `https://${extId}.chromiumapp.org/`;
}

function encryptToken(token) {
  const keyHex = process.env.TOKEN_ENCRYPTION_KEY;
  if (!keyHex) return null;
  const key = Buffer.from(keyHex, 'hex');
  if (key.length !== 32) return null;

  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  let encrypted = cipher.update(token, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');

  return {
    encryptedToken: encrypted + ':' + authTag,
    tokenIv: iv.toString('hex')
  };
}

router.get('/github/login', async (req, res) => {
  try {
    const state = await createOAuthState();
    res.json({ state, clientId: getEnvClientId() });
  } catch (error) {
    if (error.message === 'SERVER_CONFIG_ERROR') {
      return res.status(500).json({ error: 'Server configuration error' });
    }
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/github/exchange', async (req, res) => {
  try {
    const { code, state } = req.body;
    if (!code || !state) {
      return res.status(400).json({ error: 'Missing code or state' });
    }

    await consumeOAuthState(state);

    const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: JSON.stringify({
        client_id: getEnvClientId(),
        client_secret: getEnvClientSecret(),
        redirect_uri: getEnvRedirectUri(),
        code
      })
    });

    const tokenData = await tokenResponse.json();
    if (tokenData.error) {
      return res.status(400).json({ error: tokenData.error_description || tokenData.error });
    }

    const accessToken = tokenData.access_token;
    if (!accessToken) {
      return res.status(400).json({ error: 'No access token returned' });
    }

    const githubUser = await verifyGitHubToken(accessToken);
    const enc = encryptToken(accessToken);
    if (!enc) {
      return res.status(500).json({ error: 'Server configuration error: Token encryption key is invalid or missing' });
    }
    const user = await upsertUser(githubUser.githubId, githubUser.username, enc.encryptedToken, enc.tokenIv);
    const sessionId = await createSession(user.id);

    const origin = header(req, 'origin');
    const expectedOrigin = process.env.RELAY_EXTENSION_ID ? `chrome-extension://${process.env.RELAY_EXTENSION_ID}` : null;
    if (expectedOrigin && origin === expectedOrigin) {
      await db.query('INSERT INTO pm_extension_origins (origin) VALUES ($1) ON CONFLICT (origin) DO UPDATE SET updated_at = now()', [origin]);
    }

    res.cookie('relay_pm_session', sessionId, {
      httpOnly: true,
      secure: true,
      sameSite: 'None',
      maxAge: 24 * 60 * 60 * 1000,
      path: '/api/'
    });

    res.json({ ok: true, username: user.github_username });
  } catch (error) {
    if (error.message === 'SERVER_CONFIG_ERROR') {
      return res.status(500).json({ error: 'Server configuration error' });
    }
    if (error.message === 'Invalid or expired state') {
      return res.status(401).json({ error: 'Invalid or expired state' });
    }
    if (error.message === 'Invalid or expired GitHub token') {
      return res.status(401).json({ error: 'Invalid or expired GitHub token' });
    }
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/logout', async (req, res) => {
  try {
    const cookies = parseCookies(req);
    const sessionId = cookies['relay_pm_session'];
    if (sessionId) {
      await revokeSession(sessionId);
    }
    res.clearCookie('relay_pm_session', {
      httpOnly: true,
      secure: true,
      sameSite: 'None',
      path: '/api/'
    });
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
