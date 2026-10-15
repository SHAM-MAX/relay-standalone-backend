import test from 'node:test';
import assert from 'node:assert/strict';
import db from '../lib/db.js';
import { runMigrations } from '../lib/migrator.js';
import projectStore from '../lib/project-store.js';
import traceabilityStore from '../lib/traceability-store.js';
import traceabilityEndpoint from '../api/pm/traceability.js';
import { newDb } from 'pg-mem';
import crypto from 'node:crypto';

function createIsolatedTestDatabase() {
  const memDb = newDb();
  memDb.public.registerFunction({
    name: 'gen_random_uuid',
    impure: true,
    implementation: () => crypto.randomUUID()
  });
  const memPg = memDb.adapters.createPg();
  const pool = new memPg.Pool();
  pool.__isMemoryPool = true;
  return { memDb, pool };
}

test('Traceability Store & Fixes', async (t) => {
  const { pool } = createIsolatedTestDatabase();
  db.setPool(pool);
  await runMigrations({ pool });

  let projectId;

  await t.test('1. Setup project', async () => {
    const project = await projectStore.upsertProject({
      owner: 'test-owner',
      repository: 'test-repo',
      description: 'Traceability test'
    });
    projectId = project.id;
    assert.ok(projectId);
  });

  await t.test('2. Concurrent requirement ID allocations', async () => {
    // Generate 5 requirements concurrently
    const promises = [];
    for(let i = 0; i < 5; i++) {
      promises.push(traceabilityStore.createRequirement(projectId, `Req ${i}`, 'Desc'));
    }
    const results = await Promise.all(promises);

    // Check IDs
    const ids = results.map(r => r.req_id).sort();
    assert.deepEqual(ids, ['REQ-001', 'REQ-002', 'REQ-003', 'REQ-004', 'REQ-005']);
  });

  await t.test('3. Concurrent work-item ID allocations', async () => {
    const promises = [];
    for(let i = 0; i < 5; i++) {
      promises.push(traceabilityStore.createWorkItem(projectId, null, 'user_story', `Task ${i}`, 'Desc'));
    }
    const results = await Promise.all(promises);

    const ids = results.map(r => r.item_id).sort();
    assert.deepEqual(ids, ['USR-001', 'USR-002', 'USR-003', 'USR-004', 'USR-005']);
  });

  await t.test('4. Repeated submission of the same issue plan (Idempotency)', async () => {
    const req1 = await traceabilityStore.createRequirement(projectId, 'Batch 1', 'Desc', 'approved', 'hash123');
    const req2 = await traceabilityStore.createRequirement(projectId, 'Batch 1', 'Desc', 'approved', 'hash123');

    assert.equal(req1.id, req2.id); // Must be the exact same requirement row

    const item1 = await traceabilityStore.createWorkItem(projectId, req1.id, 'bug', 'Bug 1', '', 'draft', 'issue-1');
    const item2 = await traceabilityStore.createWorkItem(projectId, req1.id, 'bug', 'Bug 1', '', 'draft', 'issue-1');

    assert.equal(item1.id, item2.id); // Must be exactly the same work item row
  });

  await t.test('5. Partial batch failure & DB failure', async () => {
    // Ensure that standard failures are correctly thrown
    await assert.rejects(
      traceabilityStore.createRequirement(null, 'No Project', 'Desc'),
      /Missing projectId/
    );
  });

  await t.test('6. Isolation between projects', async () => {
    const project2 = await projectStore.upsertProject({
      owner: 'other-owner',
      repository: 'other-repo',
      description: 'Project 2'
    });

    const req = await traceabilityStore.createRequirement(project2.id, 'P2 Req', 'Desc');
    // Counters should restart for the new project
    assert.equal(req.req_id, 'REQ-001');

    const item = await traceabilityStore.createWorkItem(project2.id, req.id, 'task', 'P2 Task', 'Desc');
    assert.equal(item.item_id, 'TSK-001');
  });

  await t.test('7. Traceability Engine: Acceptance criteria extraction', async () => {
    const { extractAcceptanceCriteria } = await import('../lib/traceability-engine.js');
    const text = `
Feature: User Login
Some overview details.

## ACCEPTANCE CRITERIA
- [x] Must validate email format
- [ ] Must support OAuth 2.0 flow
* Session expires after 7 days
1. Password reset link works

## NOTES
Additional notes.
`;
    const criteria = extractAcceptanceCriteria(text);
    assert.equal(criteria.length, 4);
    assert.equal(criteria[0].text, 'Must validate email format');
    assert.equal(criteria[0].completed, true);
    assert.equal(criteria[1].text, 'Must support OAuth 2.0 flow');
    assert.equal(criteria[1].completed, false);
    assert.equal(criteria[2].text, 'Session expires after 7 days');
    assert.equal(criteria[3].text, 'Password reset link works');
  });

  await t.test('8. Traceability Engine: PR-to-issue reference extraction', async () => {
    const { extractReferencedIssueNumbers } = await import('../lib/traceability-engine.js');
    const pr = {
      title: 'Fixes #42 and updates styling',
      body: 'This PR closes #100 and resolves #101. Also relates to #42 again.',
      head: { ref: 'feature/issue-99' }
    };
    const issues = extractReferencedIssueNumbers(pr);
    assert.ok(issues.includes(42));
    assert.ok(issues.includes(100));
    assert.ok(issues.includes(101));
  });

  await t.test('9. Traceability Engine: Distinguish verified completion from merely closed/merged', async () => {
    const { evaluateTestEvidence, computeRequirementDeliveryStatus } = await import('../lib/traceability-engine.js');
    
    // Case A: Merged PR with successful CI
    const ev1 = evaluateTestEvidence('success', 'closed', '2026-10-15T00:00:00Z');
    assert.equal(ev1.verificationState, 'verified');

    // Case B: Merged PR with failed CI
    const ev2 = evaluateTestEvidence('failure', 'closed', '2026-10-15T00:00:00Z');
    assert.equal(ev2.verificationState, 'failed');

    // Case C: Merged PR with no CI / missing checks
    const ev3 = evaluateTestEvidence('missing', 'closed', '2026-10-15T00:00:00Z');
    assert.equal(ev3.verificationState, 'unverified');

    // Delivery Status computation:
    // Req with verified PR
    const statusVerified = computeRequirementDeliveryStatus({ id: 'r1' }, [
      {
        github_issue_number: 10,
        githubIssue: { state: 'closed' },
        pullRequests: [{ merged_at: '2026-10-15T00:00:00Z', evidence: ev1 }]
      }
    ]);
    assert.equal(statusVerified.status, 'verified_complete');
    assert.equal(statusVerified.isVerified, true);

    // Req with merged PR but unverified CI
    const statusUnverified = computeRequirementDeliveryStatus({ id: 'r2' }, [
      {
        github_issue_number: 11,
        githubIssue: { state: 'closed' },
        pullRequests: [{ merged_at: '2026-10-15T00:00:00Z', evidence: ev3 }]
      }
    ]);
    assert.equal(statusUnverified.status, 'delivered_unverified');
    assert.equal(statusUnverified.isVerified, false);

    // Req with failed CI checks
    const statusFailed = computeRequirementDeliveryStatus({ id: 'r3' }, [
      {
        github_issue_number: 12,
        githubIssue: { state: 'open' },
        pullRequests: [{ merged_at: null, evidence: ev2 }]
      }
    ]);
    assert.equal(statusFailed.status, 'checks_failed');

    // Req with no issues
    const statusNoIssues = computeRequirementDeliveryStatus({ id: 'r4' }, []);
    assert.equal(statusNoIssues.status, 'missing_work_items');
  });

  await t.test('10. Traceability Engine: Full Matrix & Gap Analysis', async () => {
    const { buildTraceabilityMatrix } = await import('../lib/traceability-engine.js');
    
    const rawTraceability = [
      {
        id: 'req-1',
        req_id: 'REQ-001',
        title: 'Authentication Module',
        description: '## ACCEPTANCE CRITERIA\n- [x] JWT sessions\n- [ ] OAuth login',
        status: 'approved',
        workItems: [
          {
            id: 'wi-1',
            item_id: 'TSK-001',
            type: 'task',
            title: 'Implement JWT session handling',
            github_issue_number: 101,
            github_issue_url: 'https://github.com/test-owner/test-repo/issues/101',
            description: 'Work item details'
          },
          {
            id: 'wi-2',
            item_id: 'TSK-002',
            type: 'task',
            title: 'Unpublished OAuth task',
            github_issue_number: null,
            github_issue_url: null,
            description: ''
          }
        ]
      },
      {
        id: 'req-2',
        req_id: 'REQ-002',
        title: 'Empty requirement with no work items',
        description: 'No tasks',
        status: 'draft',
        workItems: []
      }
    ];

    const githubIssues = [
      {
        number: 101,
        title: 'Implement JWT session handling',
        state: 'closed',
        html_url: 'https://github.com/test-owner/test-repo/issues/101'
      }
    ];

    const githubPulls = [
      {
        number: 201,
        title: 'Fixes #101 with verified JWT flow',
        state: 'closed',
        merged_at: '2026-10-15T00:00:00Z',
        html_url: 'https://github.com/test-owner/test-repo/pull/201',
        head: { sha: 'abcdef' },
        ciStatus: 'success'
      },
      {
        number: 202,
        title: 'Unlinked PR without any issue reference',
        state: 'open',
        html_url: 'https://github.com/test-owner/test-repo/pull/202',
        head: { sha: '123456' },
        ciStatus: 'pending'
      }
    ];

    const matrix = buildTraceabilityMatrix(rawTraceability, githubIssues, githubPulls);

    assert.equal(matrix.requirements.length, 2);
    assert.equal(matrix.summary.totalRequirements, 2);

    // Gaps verification:
    // 1. REQ-002 has no work items, wi-2 has no published issue
    assert.ok(matrix.gaps.requirementsWithoutIssues.length >= 2);
    // 2. PR #202 has no requirement or issue links
    assert.equal(matrix.gaps.prsWithoutRequirements.length, 1);
    assert.equal(matrix.gaps.prsWithoutRequirements[0].prNumber, 202);
  });

  await t.test('11. Regression: Extension GET without Origin header succeeds; unauthorized origin rejected', async () => {
    const originalFetch = global.fetch;
    global.fetch = async (url) => {
      if (url.includes('/issues')) {
        return { ok: true, json: async () => [] };
      }
      if (url.includes('/pulls')) {
        return { ok: true, json: async () => [] };
      }
      return { ok: true, json: async () => ({}) };
    };

    const createMockReqRes = (headers = {}, query = { owner: 'test-owner', repo: 'test-repo' }) => {
      const finalHeaders = { ...headers };
      const req = {
        method: 'GET',
        headers: finalHeaders,
        query
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

    // A. Request without Origin header succeeds (does not falsely fail with EXTENSION_NOT_CONNECTED)
    const { req: noOriginReq, res: noOriginRes } = createMockReqRes();
    await traceabilityEndpoint(noOriginReq, noOriginRes);
    assert.strictEqual(noOriginRes.statusCode, 200);
    assert.ok(noOriginRes.jsonData.traceability);

    // B. Request with unauthorized Origin header is rejected with 403 EXTENSION_NOT_CONNECTED
    const { req: badOriginReq, res: badOriginRes } = createMockReqRes({
      origin: 'https://malicious-site.example.com'
    });
    await traceabilityEndpoint(badOriginReq, badOriginRes);
    assert.strictEqual(badOriginRes.statusCode, 403);
    assert.strictEqual(badOriginRes.jsonData.code, 'EXTENSION_NOT_CONNECTED');

    // C. Preflight OPTIONS for unapproved origin is 204 or rejected if origin invalid
    const { req: optionsReq, res: optionsRes } = createMockReqRes({ origin: 'https://relay-ai-project.hatchable.site' });
    optionsReq.method = 'OPTIONS';
    await traceabilityEndpoint(optionsReq, optionsRes);
    assert.strictEqual(optionsRes.statusCode, 204);

    global.fetch = originalFetch;
  });

  await t.test('12. Case-insensitive project identity resolution in traceability', async () => {
    const { getProject, upsertProject } = await import('../lib/project-store.js');
    await upsertProject({ owner: 'Test-Owner-Case', repository: 'Test-Repo-Case' });

    const lowerMatch = await getProject('test-owner-case', 'test-repo-case');
    assert.ok(lowerMatch, 'LOWER case search should match mixed-case project');
    assert.strictEqual(lowerMatch.github_owner, 'Test-Owner-Case');

    const upperMatch = await getProject('TEST-OWNER-CASE', 'TEST-REPO-CASE');
    assert.ok(upperMatch, 'UPPER case search should match mixed-case project');
  });
});


