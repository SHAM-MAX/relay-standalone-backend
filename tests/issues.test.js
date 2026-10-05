import { test, mock } from 'node:test';
import assert from 'node:assert';
import issuesEndpoint from '../api/github/issues.js';

test('Issues API Tests', async (t) => {
  // Helper to mock request/response
  const createMockReqRes = (body, method = 'POST') => {
    const req = {
      method,
      headers: {
        'origin': 'https://relay-ai-project.hatchable.site',
        'content-type': 'application/json'
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
  process.env.GITHUB_TOKEN = 'test-token';

  await t.test('1. Valid issue creation request', async () => {
    const { req, res } = createMockReqRes({
      context: { owner: 'test', repository: 'repo' },
      issuePlan: { issues: [{ title: 'New Issue', body: 'Issue body', labels: ['bug'] }] }
    });

    const originalFetch = global.fetch;
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
    global.fetch = originalFetch;

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
    global.fetch = async (url, options) => {
      const body = JSON.parse(options.body);
      if (body.title === 'Good') {
        return { ok: true, json: async () => ({ title: 'Good', number: 1, html_url: '...' }) };
      }
      return { ok: false, status: 422, text: async () => 'Validation failed' };
    };

    await issuesEndpoint(req, res);
    global.fetch = originalFetch;

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.jsonData.results.length, 2);
    assert.strictEqual(res.jsonData.results[0].status, 'success');
    assert.strictEqual(res.jsonData.results[1].status, 'error');
    assert.ok(res.jsonData.results[1].error.includes('422'));
  });

  process.env.GITHUB_TOKEN = oldEnv;
});
