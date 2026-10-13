import test from 'node:test';
import assert from 'node:assert';
import crypto from 'node:crypto';
import repositoriesEndpoint from '../api/github/repositories.js';
import db from '../lib/db.js';
import { runMigrations } from '../lib/migrator.js';
import { upsertUser } from '../lib/auth.js';
import { createSession } from '../lib/session.js';

test('Repositories API Tests', async (t) => {
  await runMigrations();

  const originalEnv = { ...process.env };
  process.env.TOKEN_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
  process.env.RELAY_ORIGIN = 'https://relay-ai-project.hatchable.site';

  const createMockReqRes = (headers = {}, method = 'GET') => {
    const finalHeaders = {
      'origin': process.env.RELAY_ORIGIN,
      ...headers
    };
    if (headers && 'origin' in headers && headers.origin === undefined) {
      delete finalHeaders.origin;
    }

    const req = {
      method,
      headers: finalHeaders
    };
    const res = {
      headers: {},
      statusCode: 200,
      jsonData: null,
      setHeader(k, v) { this.headers[k] = v; },
      status(code) { this.statusCode = code; return this; },
      json(data) { this.jsonData = data; return this; },
      send(data) { this.jsonData = data; return this; }
    };
    return { req, res };
  };

  const createEncryptedToken = (tokenStr) => {
    const key = Buffer.from(process.env.TOKEN_ENCRYPTION_KEY, 'hex');
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    let encryptedText = cipher.update(tokenStr, 'utf8', 'hex');
    encryptedText += cipher.final('hex');
    const authTag = cipher.getAuthTag().toString('hex');
    return {
      encrypted_token: `${encryptedText}:${authTag}`,
      token_iv: iv.toString('hex')
    };
  };

  let validSessionId;
  let noTokenSessionId;
  let invalidTokenSessionId;

  await t.test('Setup users and sessions', async () => {
    // 1. User with valid token
    const { encrypted_token: validEnc, token_iv: validIv } = createEncryptedToken('valid-github-token');
    const user1 = await upsertUser('repo-gh-1', 'user1', validEnc, validIv);
    validSessionId = await createSession(user1.id);

    // 2. User with missing token
    const user2 = await upsertUser('repo-gh-2', 'user2');
    noTokenSessionId = await createSession(user2.id);

    // 3. User with invalid encrypted token (cannot be decrypted)
    const user3 = await upsertUser('repo-gh-3', 'user3', 'invalid-format-token', 'invalid-iv');
    invalidTokenSessionId = await createSession(user3.id);
  });

  await t.test('1. Missing session', async () => {
    const { req, res } = createMockReqRes();
    await repositoriesEndpoint(req, res);
    assert.strictEqual(res.statusCode, 401);
    assert.strictEqual(res.jsonData.code, 'UNAUTHORIZED');
  });

  await t.test('2. Missing token', async () => {
    const { req, res } = createMockReqRes({ cookie: `relay_pm_session=${noTokenSessionId}` });
    await repositoriesEndpoint(req, res);
    assert.strictEqual(res.statusCode, 401);
    assert.strictEqual(res.jsonData.code, 'MISSING_GITHUB_TOKEN');
  });

  await t.test('3. Invalid encrypted token', async () => {
    const { req, res } = createMockReqRes({ cookie: `relay_pm_session=${invalidTokenSessionId}` });
    await repositoriesEndpoint(req, res);
    assert.strictEqual(res.statusCode, 401);
    assert.strictEqual(res.jsonData.code, 'INVALID_GITHUB_TOKEN');
  });

  await t.test('4. Successful repository fetch', async () => {
    const { req, res } = createMockReqRes({ cookie: `relay_pm_session=${validSessionId}` });

    const originalFetch = global.fetch;
    global.fetch = async (url, options) => {
      assert.strictEqual(url, 'https://api.github.com/user/repos?sort=updated&per_page=100');
      assert.strictEqual(options.headers.Authorization, 'Bearer valid-github-token');
      return {
        ok: true,
        json: async () => ([
          {
            id: 1,
            name: 'test-repo',
            full_name: 'user1/test-repo',
            html_url: 'https://github.com/user1/test-repo',
            private: true,
            owner: { login: 'user1' }
          }
        ])
      };
    };

    await repositoriesEndpoint(req, res);
    global.fetch = originalFetch;

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.jsonData.repositories.length, 1);
    assert.strictEqual(res.jsonData.repositories[0].name, 'test-repo');
  });

  await t.test('5. GitHub API failures', async () => {
    const { req, res } = createMockReqRes({ cookie: `relay_pm_session=${validSessionId}` });

    const originalFetch = global.fetch;

    // Test 401
    global.fetch = async () => ({ ok: false, status: 401 });
    await repositoriesEndpoint(req, res);
    assert.strictEqual(res.statusCode, 401);
    assert.strictEqual(res.jsonData.code, 'GITHUB_API_ERROR');

    // Test 403 (Rate Limit or Forbidden)
    global.fetch = async () => ({ ok: false, status: 403 });
    await repositoriesEndpoint(req, res);
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(res.jsonData.code, 'GITHUB_API_ERROR');

    // Test 500
    global.fetch = async () => ({ ok: false, status: 500 });
    await repositoriesEndpoint(req, res);
    assert.strictEqual(res.statusCode, 500);
    assert.strictEqual(res.jsonData.code, 'GITHUB_API_ERROR');

    global.fetch = originalFetch;
  });

  await t.test('6. Chrome extension origin authorization and CORS', async () => {
    const extId = 'e'.repeat(32);
    const configuredOrigin = `chrome-extension://${extId}`;
    const unapprovedOrigin = `chrome-extension://${'f'.repeat(32)}`;
    process.env.RELAY_EXTENSION_ID = extId;

    // A. OPTIONS preflight from configured extension origin succeeds
    const { req: optReq, res: optRes } = createMockReqRes({
      origin: configuredOrigin,
      'access-control-request-method': 'GET',
      'access-control-request-headers': 'content-type'
    }, 'OPTIONS');
    await repositoriesEndpoint(optReq, optRes);
    assert.strictEqual(optRes.statusCode, 204);
    assert.strictEqual(optRes.headers['Access-Control-Allow-Origin'], configuredOrigin);
    assert.strictEqual(optRes.headers['Access-Control-Allow-Credentials'], 'true');

    // B. Authorized extension origin with valid session succeeds
    const originalFetch = global.fetch;
    global.fetch = async () => ({
      ok: true,
      json: async () => [{ id: 1, name: 'ext-repo', full_name: 'user1/ext-repo', html_url: 'https://github.com/user1/ext-repo', private: false, owner: { login: 'user1' } }]
    });

    const { req: extReq, res: extRes } = createMockReqRes({
      origin: configuredOrigin,
      cookie: `relay_pm_session=${validSessionId}`
    });
    await repositoriesEndpoint(extReq, extRes);
    assert.strictEqual(extRes.statusCode, 200);
    assert.strictEqual(extRes.headers['Access-Control-Allow-Origin'], configuredOrigin);
    assert.strictEqual(extRes.jsonData.repositories.length, 1);
    assert.strictEqual(extRes.jsonData.repositories[0].name, 'ext-repo');

    // C. Authorized extension origin without session returns 401 with CORS headers
    const { req: noAuthReq, res: noAuthRes } = createMockReqRes({
      origin: configuredOrigin
    });
    await repositoriesEndpoint(noAuthReq, noAuthRes);
    assert.strictEqual(noAuthRes.statusCode, 401);
    assert.strictEqual(noAuthRes.jsonData.code, 'UNAUTHORIZED');
    assert.strictEqual(noAuthRes.headers['Access-Control-Allow-Origin'], configuredOrigin);

    // D. Unauthorized extension origin returns 403 EXTENSION_NOT_CONNECTED
    const { req: unauthReq, res: unauthRes } = createMockReqRes({
      origin: unapprovedOrigin
    });
    await repositoriesEndpoint(unauthReq, unauthRes);
    assert.strictEqual(unauthRes.statusCode, 403);
    assert.strictEqual(unauthRes.jsonData.code, 'EXTENSION_NOT_CONNECTED');

    global.fetch = originalFetch;
  });

  await t.test('7. Omitted Origin header (direct/extension GET) handling', async () => {
    const originalFetch = global.fetch;
    global.fetch = async () => ({
      ok: true,
      json: async () => [{ id: 42, name: 'no-origin-repo', full_name: 'user1/no-origin-repo', html_url: 'https://github.com/user1/no-origin-repo', private: false, owner: { login: 'user1' } }]
    });

    // A. Request without Origin header but with valid session cookie succeeds (200 OK)
    const { req: noOriginAuthedReq, res: noOriginAuthedRes } = createMockReqRes({
      origin: undefined,
      cookie: `relay_pm_session=${validSessionId}`
    });
    await repositoriesEndpoint(noOriginAuthedReq, noOriginAuthedRes);
    assert.strictEqual(noOriginAuthedRes.statusCode, 200);
    assert.strictEqual(noOriginAuthedRes.jsonData.repositories.length, 1);
    assert.strictEqual(noOriginAuthedRes.jsonData.repositories[0].name, 'no-origin-repo');

    // B. Request without Origin header and without session cookie returns 401 UNAUTHORIZED (not 403)
    const { req: noOriginUnauthReq, res: noOriginUnauthRes } = createMockReqRes({
      origin: undefined
    });
    await repositoriesEndpoint(noOriginUnauthReq, noOriginUnauthRes);
    assert.strictEqual(noOriginUnauthRes.statusCode, 401);
    assert.strictEqual(noOriginUnauthRes.jsonData.code, 'UNAUTHORIZED');

    // C. Unauthorized web origin is rejected with 403 EXTENSION_NOT_CONNECTED even with cookie
    const { req: badWebReq, res: badWebRes } = createMockReqRes({
      origin: 'https://unauthorized-site.com',
      cookie: `relay_pm_session=${validSessionId}`
    });
    await repositoriesEndpoint(badWebReq, badWebRes);
    assert.strictEqual(badWebRes.statusCode, 403);
    assert.strictEqual(badWebRes.jsonData.code, 'EXTENSION_NOT_CONNECTED');

    // D. Extension request with session cookie in Cookie header succeeds without weakening authorization
    const { req: extCookieReq, res: extCookieRes } = createMockReqRes({
      origin: undefined,
      cookie: `relay_pm_session=${validSessionId}; other_cookie=xyz`
    });
    await repositoriesEndpoint(extCookieReq, extCookieRes);
    assert.strictEqual(extCookieRes.statusCode, 200);
    assert.strictEqual(extCookieRes.jsonData.repositories.length, 1);

    // E. Missing cookie is strictly rejected and never treated as authenticated
    const { req: strictReq, res: strictRes } = createMockReqRes({
      origin: undefined,
      cookie: ''
    });
    await repositoriesEndpoint(strictReq, strictRes);
    assert.strictEqual(strictRes.statusCode, 401);
    assert.strictEqual(strictRes.jsonData.code, 'UNAUTHORIZED');

    global.fetch = originalFetch;
  });

  await t.test('Cleanup', async () => {
    await db.closePool().catch(() => {});
    process.env = originalEnv;
  });
});
