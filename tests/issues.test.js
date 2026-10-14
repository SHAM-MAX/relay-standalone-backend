import { test, mock } from 'node:test';
import assert from 'node:assert';
import issuesEndpoint from '../api/github/issues.js';
import { upsertUser } from '../lib/auth.js';
import { createSession } from '../lib/session.js';
import crypto from 'crypto';
import { runMigrations } from '../lib/migrator.js';
import db from '../lib/db.js';

test('Issues API Tests', async (t) => {
  await runMigrations();

  const validKey = '0000000000000000000000000000000000000000000000000000000000000000';
  const oldKey = process.env.TOKEN_ENCRYPTION_KEY;
  process.env.TOKEN_ENCRYPTION_KEY = validKey;

  const iv = crypto.randomBytes(12).toString('hex');
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(validKey, 'hex'), Buffer.from(iv, 'hex'));
  let enc = cipher.update('mock-github-token', 'utf8', 'hex');
  enc += cipher.final('hex');
  const tag = cipher.getAuthTag().toString('hex');
  const validTokenString = `${enc}:${tag}`;

  const user = await upsertUser('issues-test-gh', 'issues-tester', validTokenString, iv);
  const sessionId = await createSession(user.id);

  // Helper to mock request/response
  const createMockReqRes = (body, method = 'POST') => {
    const req = {
      method,
      headers: {
        'origin': 'https://relay-ai-project.hatchable.site',
        'content-type': 'application/json',
        'cookie': `relay_pm_session=${sessionId}`
      },
      body
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

  const oldEnv = process.env.GITHUB_TOKEN;
  delete process.env.GITHUB_TOKEN;

  await t.test('1. Valid issue creation request', async () => {
    const { req, res } = createMockReqRes({
      context: { owner: 'test', repository: 'repo' },
      issuePlan: { issues: [{ title: 'New Issue', body: 'Issue body', labels: ['bug'] }] }
    });

    const originalFetch = global.fetch;
    try {
      global.fetch = async (url, options) => {
        assert.strictEqual(url, 'https://api.github.com/repos/test/repo/issues');
        const body = JSON.parse(options.body);
        assert.strictEqual(body.title, 'New Issue');
        return {
          ok: true,
          json: async () => ({ title: 'New Issue', number: 42, html_url: 'https://github.com/test/repo/issues/42' })
        };
      };

      await issuesEndpoint(req, res);
    } finally {
      global.fetch = originalFetch;
    }

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.jsonData.results.length, 1);
    assert.strictEqual(res.jsonData.results[0].status, 'success');
    assert.strictEqual(res.jsonData.results[0].number, 42);
  });

  await t.test('2. Invalid/malformed issuePlan', async () => {
    const { req, res } = createMockReqRes({
      context: { owner: 'test', repository: 'repo' },
      issuePlan: {} // Missing issues array
    });

    await issuesEndpoint(req, res);
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.jsonData.code, 'INVALID_ISSUE_PLAN');
  });

  await t.test('3. Partial GitHub creation failure', async () => {
    const { req, res } = createMockReqRes({
      context: { owner: 'test', repository: 'repo' },
      issuePlan: { issues: [{ title: 'Good' }, { title: 'Bad' }] }
    });

    const originalFetch = global.fetch;
    try {
      global.fetch = async (url, options) => {
        const body = JSON.parse(options.body);
        if (body.title === 'Good') {
          return { ok: true, json: async () => ({ title: 'Good', number: 1, html_url: '...' }) };
        }
        return { ok: false, status: 422, text: async () => 'Validation failed' };
      };

      await issuesEndpoint(req, res);
    } finally {
      global.fetch = originalFetch;
    }

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.jsonData.results.length, 2);
    assert.strictEqual(res.jsonData.results[0].status, 'success');
    assert.strictEqual(res.jsonData.results[1].status, 'error');
    assert.ok(res.jsonData.results[1].error.includes('422'));
  });

  await t.test('4. Normalizes malformed or composite repository context without malforming URL', async () => {
    let capturedUrl = null;
    let capturedBody = null;
    const { req, res } = createMockReqRes({
      // Notice repository is "my-org/my-project.git/" or duplicated
      context: { owner: 'my-org', repository: 'my-org/my-project.git/' },
      issuePlan: { issues: [{ id: 'task-101', title: 'Single Issue', body: 'Issue details', labels: ['enhancement'] }] }
    });

    const originalFetch = global.fetch;
    try {
      global.fetch = async (url, options) => {
        capturedUrl = url;
        capturedBody = JSON.parse(options.body);
        return {
          ok: true,
          json: async () => ({ title: 'Single Issue', number: 101, html_url: 'https://github.com/my-org/my-project/issues/101' })
        };
      };

      await issuesEndpoint(req, res);
    } finally {
      global.fetch = originalFetch;
    }

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(capturedUrl, 'https://api.github.com/repos/my-org/my-project/issues');
    assert.strictEqual(capturedBody.title, 'Single Issue');
    assert.deepEqual(capturedBody.labels, ['enhancement']);
    assert.strictEqual(res.jsonData.results.length, 1);
    assert.strictEqual(res.jsonData.results[0].status, 'success');
    assert.strictEqual(res.jsonData.results[0].number, 101);
  });

  await t.test('5. Returns clear, safe error message on GitHub 404 without leaking secrets', async () => {
    const { req, res } = createMockReqRes({
      context: { owner: 'SHAM-MAX', repository: 'GitHub-Kanban-Practice' },
      issuePlan: { issues: [{ title: 'Failed Issue' }] }
    });

    const originalFetch = global.fetch;
    try {
      global.fetch = async (url, options) => {
        return {
          ok: false,
          status: 404,
          headers: new Headers({ 'x-oauth-scopes': 'read:user' }),
          text: async () => JSON.stringify({ message: 'Not Found', documentation_url: 'https://docs.github.com/rest/issues/issues#create-an-issue' })
        };
      };

      await issuesEndpoint(req, res);
    } finally {
      global.fetch = originalFetch;
    }

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.jsonData.results.length, 1);
    assert.strictEqual(res.jsonData.results[0].status, 'error');
    assert.match(res.jsonData.results[0].error, /missing issue creation scope/i);
    assert.match(res.jsonData.results[0].error, /HTTP 404/);
    // Verify no secret tokens or auth headers leaked
    assert.doesNotMatch(res.jsonData.results[0].error, /bearer/i);
    assert.doesNotMatch(res.jsonData.results[0].error, /mock-github-token/i);
  });

  await t.test('5b. Diagnoses user lacking write permissions on 404', async () => {
    const { req, res } = createMockReqRes({
      context: { owner: 'other-user', repository: 'public-repo' },
      issuePlan: { issues: [{ title: 'Failed Issue' }] }
    });

    const originalFetch = global.fetch;
    try {
      global.fetch = async (url, options) => {
        if (options.method === 'POST') {
          return {
            ok: false,
            status: 404,
            headers: new Headers({ 'x-oauth-scopes': 'public_repo' }),
            text: async () => JSON.stringify({ message: 'Not Found' })
          };
        }
        // GET repo verification
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => ({ permissions: { push: false } })
        };
      };

      await issuesEndpoint(req, res);
    } finally {
      global.fetch = originalFetch;
    }

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.jsonData.results.length, 1);
    assert.strictEqual(res.jsonData.results[0].status, 'error');
    assert.match(res.jsonData.results[0].error, /restricted or read-only access/i);
    assert.doesNotMatch(res.jsonData.results[0].error, /bearer/i);
  });

  await t.test('6. Rejects invalid or missing repository context with 400', async () => {
    const { req, res } = createMockReqRes({
      context: { owner: '', repository: '' },
      issuePlan: { issues: [{ title: 'Issue' }] }
    });

    await issuesEndpoint(req, res);
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.jsonData.code, 'INVALID_CONTEXT');
  });

  await t.test('7. Passes assignees payload to GitHub REST issue creation', async () => {
    let capturedBody = null;
    const { req, res } = createMockReqRes({
      context: { owner: 'test', repository: 'repo' },
      issuePlan: { issues: [{ title: 'Task with Assignee', body: 'Desc', assignees: ['alice'] }] }
    });

    const originalFetch = global.fetch;
    try {
      global.fetch = async (url, options) => {
        capturedBody = JSON.parse(options.body);
        return {
          ok: true,
          json: async () => ({ title: 'Task with Assignee', number: 43, html_url: 'https://github.com/test/repo/issues/43' })
        };
      };

      await issuesEndpoint(req, res);
    } finally {
      global.fetch = originalFetch;
    }

    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(capturedBody.assignees, ['alice']);
  });

  if (oldEnv === undefined) {
    delete process.env.GITHUB_TOKEN;
  } else {
    process.env.GITHUB_TOKEN = oldEnv;
  }

  if (oldKey === undefined) {
    delete process.env.TOKEN_ENCRYPTION_KEY;
  } else {
    process.env.TOKEN_ENCRYPTION_KEY = oldKey;
  }

  await db.closePool().catch(() => {});
});
