import test from 'node:test';
import assert from 'node:assert';
import express from 'express';
import crypto from 'node:crypto';
import authRouter from '../api/auth.js';
import db from '../lib/db.js';
import { runMigrations } from '../lib/migrator.js';
import { createOAuthState } from '../lib/session.js';

test('OAuth Exchange API Tests', async (t) => {
  await runMigrations();

  const originalEnv = { ...process.env };
  process.env.RELAY_EXTENSION_ID = 'a'.repeat(32);
  process.env.GITHUB_CLIENT_ID = 'test-client-id';
  process.env.GITHUB_CLIENT_SECRET = 'test-client-secret';
  const validOrigin = `chrome-extension://${process.env.RELAY_EXTENSION_ID}`;

  // Start a local Express server to test the router
  const app = express();
  app.use(express.json());
  app.use(authRouter);
  let server;
  let baseUrl;

  await new Promise((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://localhost:${server.address().port}`;
      resolve();
    });
  });

  const makeExchangeReq = async (body, origin = validOrigin) => {
    return fetch(`${baseUrl}/github/exchange`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Origin': origin
      },
      body: JSON.stringify(body)
    });
  };

  const restoreEnv = (key, originalValue) => {
    if (originalValue === undefined) delete process.env[key];
    else process.env[key] = originalValue;
  };

  await t.test('1. Setup successful fetch mocks', async () => {
    const originalFetch = global.fetch;
    global.fetch = async (url, options) => {
      if (url === 'https://github.com/login/oauth/access_token') {
        return {
          ok: true,
          json: async () => ({ access_token: 'mock-access-token' })
        };
      }
      if (url === 'https://api.github.com/user') {
        return {
          ok: true,
          json: async () => ({ id: 9999, login: 'mockuser' })
        };
      }
      return originalFetch(url, options);
    };
    t.after(() => { global.fetch = originalFetch; });
  });

  await t.test('2. Missing TOKEN_ENCRYPTION_KEY', async () => {
    const originalVal = process.env.TOKEN_ENCRYPTION_KEY;
    delete process.env.TOKEN_ENCRYPTION_KEY;
    try {
      const state = await createOAuthState();

      const res = await makeExchangeReq({ code: 'valid-code', state });
      assert.strictEqual(res.status, 500);
      const data = await res.json();
      assert.strictEqual(data.error, 'Server configuration error: Token encryption key is invalid or missing');
    } finally {
      restoreEnv('TOKEN_ENCRYPTION_KEY', originalVal);
    }
  });

  await t.test('3. Invalid TOKEN_ENCRYPTION_KEY (wrong length)', async () => {
    const originalVal = process.env.TOKEN_ENCRYPTION_KEY;
    process.env.TOKEN_ENCRYPTION_KEY = crypto.randomBytes(16).toString('hex'); // 16 bytes instead of 32
    try {
      const state = await createOAuthState();

      const res = await makeExchangeReq({ code: 'valid-code', state });
      assert.strictEqual(res.status, 500);
      const data = await res.json();
      assert.strictEqual(data.error, 'Server configuration error: Token encryption key is invalid or missing');
    } finally {
      restoreEnv('TOKEN_ENCRYPTION_KEY', originalVal);
    }
  });

  await t.test('4. Successful token-encryption and storage flow', async () => {
    process.env.TOKEN_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex'); // valid 32 bytes
    const state = await createOAuthState();

    const res = await makeExchangeReq({ code: 'valid-code', state });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.ok, true);
    assert.strictEqual(data.username, 'mockuser');

    // Check cookie
    const cookies = res.headers.get('set-cookie');
    assert.ok(cookies);
    assert.ok(cookies.includes('relay_pm_session='));
    assert.ok(cookies.includes('Partitioned'));

    // Verify origin was recorded into pm_extension_origins
    const originCheck = await db.query('SELECT origin FROM pm_extension_origins WHERE origin = $1', [validOrigin]);
    assert.strictEqual(originCheck.rows.length, 1);
    assert.strictEqual(originCheck.rows[0].origin, validOrigin);
  });

  await t.test('5. Missing GITHUB_CLIENT_ID (missing config)', async () => {
    const originalVal = process.env.GITHUB_CLIENT_ID;
    delete process.env.GITHUB_CLIENT_ID;
    try {
      const state = await createOAuthState();
      const res = await makeExchangeReq({ code: 'valid-code', state });
      assert.strictEqual(res.status, 500);
      const data = await res.json();
      assert.strictEqual(data.error, 'Server configuration error');
    } finally {
      restoreEnv('GITHUB_CLIENT_ID', originalVal);
    }
  });

  await t.test('6. Invalid origin', async () => {
    const state = await createOAuthState();
    const res = await makeExchangeReq({ code: 'valid-code', state }, 'https://hacker.com');
    assert.strictEqual(res.status, 403);
    const data = await res.json();
    assert.strictEqual(data.error, 'Origin not allowed');
  });

  await t.test('7. Invalid or expired state', async () => {
    const res = await makeExchangeReq({ code: 'valid-code', state: 'made-up-state' });
    assert.strictEqual(res.status, 401);
    const data = await res.json();
    assert.strictEqual(data.error, 'Invalid or expired state');
  });

  await t.test('8. Missing GITHUB_CLIENT_SECRET (missing config)', async () => {
    const originalVal = process.env.GITHUB_CLIENT_SECRET;
    delete process.env.GITHUB_CLIENT_SECRET;
    try {
      const state = await createOAuthState();
      const res = await makeExchangeReq({ code: 'valid-code', state });
      assert.strictEqual(res.status, 500);
      const data = await res.json();
      assert.strictEqual(data.error, 'Server configuration error');
    } finally {
      restoreEnv('GITHUB_CLIENT_SECRET', originalVal);
    }
  });

  await t.test('9. Unexpected GitHub network/API failure', async () => {
    const originalFetch = global.fetch;
    try {
      global.fetch = async (url, options) => {
        if (url.startsWith('http://localhost')) return originalFetch(url, options);
        throw new Error('fetch failed');
      };
      const state = await createOAuthState();
      const res = await makeExchangeReq({ code: 'valid-code', state });
      assert.strictEqual(res.status, 500);
      const data = await res.json();
      assert.strictEqual(data.error, 'Internal server error');
    } finally {
      global.fetch = originalFetch;
    }
  });

  await t.test('10. GET /github/login allows configured extension origin before authentication', async () => {
    const res = await fetch(`${baseUrl}/github/login`, {
      method: 'GET',
      headers: {
        'Origin': validOrigin
      }
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('access-control-allow-origin'), validOrigin);
    assert.strictEqual(res.headers.get('access-control-allow-credentials'), 'true');
    const data = await res.json();
    assert.strictEqual(typeof data.state, 'string');
    assert.strictEqual(data.clientId, 'test-client-id');
    assert.strictEqual(data.redirectUri, `https://${process.env.RELAY_EXTENSION_ID}.chromiumapp.org/`);
  });

  await t.test('11. OPTIONS /github/login preflight succeeds for configured extension origin', async () => {
    const res = await fetch(`${baseUrl}/github/login`, {
      method: 'OPTIONS',
      headers: {
        'Origin': validOrigin
      }
    });
    assert.strictEqual(res.status, 204);
    assert.strictEqual(res.headers.get('access-control-allow-origin'), validOrigin);
  });

  await t.test('12. GET /github/login rejects unauthorized extension origin', async () => {
    const unauthorizedOrigin = `chrome-extension://${'b'.repeat(32)}`;
    const res = await fetch(`${baseUrl}/github/login`, {
      method: 'GET',
      headers: {
        'Origin': unauthorizedOrigin
      }
    });
    assert.strictEqual(res.status, 403);
    const data = await res.json();
    assert.strictEqual(data.error, 'Origin not allowed');
  });

  await t.test('13. OPTIONS /github/login preflight rejects unauthorized extension origin', async () => {
    const unauthorizedOrigin = `chrome-extension://${'b'.repeat(32)}`;
    const res = await fetch(`${baseUrl}/github/login`, {
      method: 'OPTIONS',
      headers: {
        'Origin': unauthorizedOrigin
      }
    });
    assert.strictEqual(res.status, 403);
    const data = await res.json();
    assert.strictEqual(data.error, 'Origin not allowed');
  });

  await t.test('14. POST /github/exchange rejects mismatched redirect_uri', async () => {
    process.env.TOKEN_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
    const state = await createOAuthState();
    const res = await makeExchangeReq({
      code: 'valid-code',
      state,
      redirect_uri: 'https://wrong-extension-id.chromiumapp.org/'
    });
    assert.strictEqual(res.status, 400);
    const data = await res.json();
    assert.strictEqual(data.error, 'Redirect URI mismatch');
  });

  await t.test('15. POST /logout clears session cookie with Partitioned attribute', async () => {
    const res = await fetch(`${baseUrl}/logout`, {
      method: 'POST',
      headers: {
        'Origin': validOrigin
      }
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.ok, true);
    const setCookie = res.headers.get('set-cookie');
    assert.ok(setCookie);
    assert.ok(setCookie.includes('relay_pm_session=;'));
    assert.ok(setCookie.includes('Partitioned'));
  });

  t.after(async () => {
    if (server) {
      server.close();
    }
    await db.closePool().catch(() => {});

    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    }
    for (const [key, value] of Object.entries(originalEnv)) {
      process.env[key] = value;
    }
  });
});
