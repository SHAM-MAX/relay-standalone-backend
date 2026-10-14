import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import db from '../lib/db.js';
import { runMigrations } from '../lib/migrator.js';
import projectStore from '../lib/project-store.js';
import developerStore from '../lib/developer-store.js';
import scheduleEngine from '../lib/schedule-engine.js';
import traceabilityStore from '../lib/traceability-store.js';
import projectHealthEngine from '../lib/project-health-engine.js';
import { upsertUser, setProjectRole } from '../lib/auth.js';
import { createSession } from '../lib/session.js';
import healthRouter from '../api/pm/health.js';

test('Project Health Intelligence Engine & API', async (t) => {
  await runMigrations();

  const originalEnv = { ...process.env };
  const testOwner = 'health-test-org';
  const testRepo = 'health-test-repo';
  const project = await projectStore.upsertProject({
    owner: testOwner,
    repository: testRepo,
    name: 'Health Test',
    description: 'Testing health'
  });

  const pmUser = await upsertUser('gh-pm-501', 'pmuser');
  const devAlice = await upsertUser('gh-alice-502', 'alice');
  const devBob = await upsertUser('gh-bob-503', 'bob');

  await setProjectRole(project.id, pmUser.id, 'Manager');
  await setProjectRole(project.id, devAlice.id, 'Viewer');
  await setProjectRole(project.id, devBob.id, 'Viewer');

  // Start test Express server
  const app = express();
  app.use(express.json());
  app.use('/api/pm/health', healthRouter);

  let server;
  let baseUrl;
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://localhost:${server.address().port}`;
      resolve();
    });
  });

  t.after(async () => {
    if (server) await new Promise((res) => server.close(res));
    await db.query(`DELETE FROM pm_projects WHERE id = $1`, [project.id]).catch(() => {});
    await db.query(`DELETE FROM pm_users WHERE id IN ($1, $2, $3)`, [pmUser.id, devAlice.id, devBob.id]).catch(() => {});

    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    for (const [key, value] of Object.entries(originalEnv)) {
      process.env[key] = value;
    }
  });

  await t.test('1. calculateProjectHealth detects overdue work only when reliable deadline exists', () => {
    const now = Date.now();
    const pastDate = new Date(now - 86400000 * 3).toISOString(); // 3 days ago
    const futureDate = new Date(now + 86400000 * 5).toISOString(); // 5 days in future

    const githubIssues = [
      {
        number: 10,
        title: 'Overdue Issue',
        state: 'open',
        milestone: { title: 'v1.0 Release', due_on: pastDate }
      },
      {
        number: 11,
        title: 'On-track Issue with Milestone',
        state: 'open',
        milestone: { title: 'v1.0 Release', due_on: futureDate }
      },
      {
        number: 12,
        title: 'Issue without any deadline',
        state: 'open',
        milestone: null
      }
    ];

    const result = projectHealthEngine.calculateProjectHealth({
      project: { owner: testOwner, repository: testRepo },
      githubIssues,
      githubPulls: [],
      milestones: [],
      scheduleItems: [],
      developerProfiles: [],
      evidenceByUser: {}
    });

    assert.equal(result.summary.overdueCount, 1);
    assert.equal(result.criticalIssues.length, 1);
    assert.equal(result.criticalIssues[0].number, 10);
    assert.equal(result.criticalIssues[0].type, 'overdue_issue');
    assert.equal(result.overallStatus, 'at_risk');
  });

  await t.test('2. calculateProjectHealth identifies stalled tasks using configurable threshold', () => {
    const now = Date.now();
    const tenDaysAgo = new Date(now - 86400000 * 10).toISOString();
    const twoDaysAgo = new Date(now - 86400000 * 2).toISOString();

    const githubIssues = [
      {
        number: 21,
        title: 'Stalled Task',
        state: 'open',
        updated_at: tenDaysAgo,
        labels: []
      },
      {
        number: 22,
        title: 'Active Task',
        state: 'open',
        updated_at: twoDaysAgo,
        labels: []
      }
    ];

    const result = projectHealthEngine.calculateProjectHealth({
      project: { owner: testOwner, repository: testRepo },
      githubIssues,
      githubPulls: [],
      milestones: [],
      scheduleItems: [],
      developerProfiles: [],
      evidenceByUser: {},
      options: { stalledThresholdDays: 7 }
    });

    assert.equal(result.summary.stalledCount, 1);
    assert.equal(result.criticalIssues[0].number, 21);
    assert.equal(result.criticalIssues[0].type, 'stalled_issue');
    assert.equal(result.overallStatus, 'needs_attention');
  });

  await t.test('3. calculateProjectHealth detects blocked tasks and critical path dependency risks', () => {
    const githubIssues = [
      {
        number: 31,
        title: 'Blocked Task',
        state: 'open',
        labels: [{ name: 'blocked' }]
      }
    ];

    const scheduleItems = [
      {
        work_item_id: 'wi-1',
        item_id: 'TSK-001',
        title: 'Core Engine Task',
        slack: 0,
        is_critical: true
      }
    ];

    const result = projectHealthEngine.calculateProjectHealth({
      project: { owner: testOwner, repository: testRepo },
      githubIssues,
      githubPulls: [],
      milestones: [],
      scheduleItems,
      developerProfiles: [],
      evidenceByUser: {}
    });

    assert.equal(result.summary.blockedCount, 1);
    assert.equal(result.summary.dependencyRisksCount, 1);
    assert.equal(result.overallStatus, 'at_risk');
    assert.ok(result.riskExplanations.some(r => r.includes('critical path')));
  });

  await t.test('4. calculateProjectHealth highlights developer workload concerns', () => {
    const developerProfiles = [
      {
        github_username: 'alice',
        max_concurrent_tasks: 2,
        weekly_capacity_hours: 40,
        is_available: true
      },
      {
        github_username: 'bob',
        max_concurrent_tasks: 3,
        weekly_capacity_hours: 40,
        is_available: false
      }
    ];

    const evidenceByUser = {
      alice: { openAssignedIssuesCount: 4 },
      bob: { openAssignedIssuesCount: 0 }
    };

    const result = projectHealthEngine.calculateProjectHealth({
      project: { owner: testOwner, repository: testRepo },
      githubIssues: [],
      githubPulls: [],
      milestones: [],
      scheduleItems: [],
      developerProfiles,
      evidenceByUser
    });

    assert.equal(result.summary.workloadConcernsCount, 2);
    assert.ok(result.workloadConcerns.some(w => w.username === 'alice' && w.type === 'overallocated'));
    assert.ok(result.workloadConcerns.some(w => w.username === 'bob' && w.type === 'unavailable'));
  });

  await t.test('5. calculateProjectHealth identifies PRs awaiting review or failing CI', () => {
    const githubPulls = [
      {
        number: 41,
        title: 'Add Auth Feature',
        state: 'open',
        draft: false,
        requested_reviewers: [{ login: 'alice' }],
        ciStatus: 'failure'
      },
      {
        number: 42,
        title: 'Draft Docs',
        state: 'open',
        draft: true
      }
    ];

    const result = projectHealthEngine.calculateProjectHealth({
      project: { owner: testOwner, repository: testRepo },
      githubIssues: [],
      githubPulls,
      milestones: [],
      scheduleItems: [],
      developerProfiles: [],
      evidenceByUser: {}
    });

    assert.equal(result.summary.prConcernsCount, 2); // 1 awaiting review, 1 failing CI
    assert.ok(result.prConcerns.some(p => p.number === 41 && p.type === 'awaiting_review'));
    assert.ok(result.prConcerns.some(p => p.number === 41 && p.type === 'ci_failed'));
    assert.ok(result.recommendedActions.some(a => a.prNumber === 41));
  });

  await t.test('6. GET /api/pm/health endpoint requires authentication and returns structured health', async () => {
    // 6.1 Unauthorized request without cookie
    const unauthRes = await fetch(`${baseUrl}/api/pm/health?owner=${testOwner}&repo=${testRepo}`);
    assert.equal(unauthRes.status, 401);

    // 6.2 Authorized request with session cookie
    const sessionId = await createSession(pmUser.id);
    const authRes = await fetch(`${baseUrl}/api/pm/health?owner=${testOwner}&repo=${testRepo}`, {
      headers: {
        Cookie: `relay_pm_session=${sessionId}`
      }
    });

    assert.equal(authRes.status, 200);
    const data = await authRes.json();
    assert.ok(data.health);
    assert.ok(data.health.summary);
    assert.ok(Array.isArray(data.health.criticalIssues));
    assert.ok(Array.isArray(data.health.riskExplanations));
    assert.ok(Array.isArray(data.health.recommendedActions));
    assert.equal(data.context.owner, testOwner);
    assert.equal(data.context.repo, testRepo);
  });
});
