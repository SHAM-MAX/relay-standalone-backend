import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { generatePmReports } from '../lib/pm-reports-engine.js';
import db from '../lib/db.js';
import { runMigrations } from '../lib/migrator.js';
import projectStore from '../lib/project-store.js';
import { upsertUser, setProjectRole } from '../lib/auth.js';
import { createSession } from '../lib/session.js';
import reportsRouter from '../api/pm/reports.js';

test('PM Reports & Delivery Forecasting Intelligence Engine', async (t) => {
  const project = { owner: 'SHAM-MAX', repository: 'GitHub-Kanban-Practice' };

  await t.test('1. Generates project status report with progress, open/closed issues, and delivery gaps', () => {
    const githubIssues = [
      { number: 1, title: 'Open Task 1', state: 'open' },
      { number: 2, title: 'Open Task 2', state: 'open' },
      { number: 3, title: 'Closed Task 3', state: 'closed' },
      { number: 4, title: 'Closed Task 4', state: 'closed' },
      { number: 5, title: 'PR in issues endpoint', state: 'open', pull_request: {} }
    ];

    const githubPulls = [
      { number: 101, title: 'Feature PR', state: 'open' },
      { number: 102, title: 'Merged PR', state: 'closed', merged_at: '2026-10-15T00:00:00Z' }
    ];

    const traceabilityMatrix = {
      gaps: {
        requirementsWithoutIssues: [{ reqId: 'REQ-002', title: 'Empty Req' }],
        issuesWithoutPrs: [{ issueNumber: 1, title: 'Open Task 1' }],
        prsWithoutRequirements: [],
        totalGaps: 2
      }
    };

    const risks = [
      { id: 'r1', risk_id: 'RSK-001', title: 'High API Latency', score: 16, status: 'active', mitigation_strategy: 'Add Redis cache' }
    ];

    const reports = generatePmReports({
      project,
      githubIssues,
      githubPulls,
      traceabilityMatrix,
      risks
    });

    const statusReport = reports.projectStatusReport;
    assert.ok(statusReport);
    assert.strictEqual(statusReport.metrics.totalIssues, 4); // Excludes pull_request item
    assert.strictEqual(statusReport.metrics.openIssues, 2);
    assert.strictEqual(statusReport.metrics.closedIssues, 2);
    assert.strictEqual(statusReport.completionRate, 50);
    assert.strictEqual(statusReport.metrics.totalGaps, 2);
    assert.strictEqual(statusReport.majorRisks.length, 1);
    assert.strictEqual(statusReport.majorRisks[0].riskId, 'RSK-001');
  });

  await t.test('2. Sprint and milestone report summarizes completion progress, blocked work, and at-risk milestones', () => {
    const milestones = [
      {
        id: 'm1',
        milestone_id: 'MS-001',
        title: 'Sprint 1',
        description: 'First iteration',
        target_date: '2026-10-01' // Past date -> overdue
      },
      {
        id: 'm2',
        milestone_id: 'MS-002',
        title: 'Sprint 2',
        description: 'Future iteration',
        target_date: '2026-12-01'
      }
    ];

    const githubIssues = [
      {
        number: 10,
        title: 'Overdue uncompleted task',
        state: 'open',
        milestone: { title: 'Sprint 1' },
        labels: []
      },
      {
        number: 11,
        title: 'Blocked task in future sprint',
        state: 'open',
        milestone: { title: 'Sprint 2' },
        labels: [{ name: 'blocked' }]
      },
      {
        number: 12,
        title: 'Done task in sprint 2',
        state: 'closed',
        milestone: { title: 'Sprint 2' }
      }
    ];

    const reports = generatePmReports({
      project,
      milestones,
      githubIssues
    });

    const msReport = reports.milestoneReport;
    assert.strictEqual(msReport.totalMilestones, 2);
    assert.strictEqual(msReport.milestonesAtRiskCount, 2); // Both m1 (overdue) and m2 (has blocked issue)

    const m1 = msReport.milestones.find(m => m.milestoneId === 'MS-001');
    assert.ok(m1.isOverdue);
    assert.strictEqual(m1.healthStatus, 'at_risk');
    assert.strictEqual(m1.completionRate, 0);

    const m2 = msReport.milestones.find(m => m.milestoneId === 'MS-002');
    assert.strictEqual(m2.healthStatus, 'at_risk');
    assert.strictEqual(m2.blockedIssues.length, 1);
    assert.strictEqual(m2.blockedIssues[0].number, 11);
  });

  await t.test('3. Delivery Forecast: Computes deterministic CPM estimates when schedule items exist', () => {
    const scheduleItems = [
      { work_item_id: 'wi-1', item_id: 'TSK-001', title: 'Backend Foundation', early_start: 0, early_finish: 5, slack: 0, is_critical: true, is_baseline: true },
      { work_item_id: 'wi-2', item_id: 'TSK-002', title: 'UI Dashboard', early_start: 5, early_finish: 12, slack: 0, is_critical: true, is_baseline: true },
      { work_item_id: 'wi-3', item_id: 'TSK-003', title: 'Documentation', early_start: 0, early_finish: 2, slack: 10, is_critical: false, is_baseline: true }
    ];

    const reports = generatePmReports({
      project,
      scheduleItems
    });

    const forecast = reports.deliveryForecast;
    assert.strictEqual(forecast.status, 'computed');
    assert.strictEqual(forecast.confidence, 'high');
    assert.strictEqual(forecast.criticalPathDurationDays, 12);
    assert.strictEqual(forecast.criticalPathItems.length, 2);
    assert.ok(forecast.estimatedCompletionDate, 'Must have estimated completion date');
    assert.ok(forecast.assumptions.length >= 2);
  });

  await t.test('4. Delivery Forecast: Does NEVER invent dates from insufficient evidence', () => {
    const reports = generatePmReports({
      project,
      scheduleItems: [] // No schedule
    });

    const forecast = reports.deliveryForecast;
    assert.strictEqual(forecast.status, 'insufficient_data');
    assert.strictEqual(forecast.confidence, 'low');
    assert.strictEqual(forecast.estimatedCompletionDate, null);
    assert.ok(forecast.limitations.includes('deterministic duration estimates'));
  });

  await t.test('5. Team Workload Summary: Distinguishes declared profiles from inferred activity', () => {
    const developerProfiles = [
      {
        user_id: 'u-1',
        github_username: 'sham-dev',
        declared_skills: ['node.js', 'react'],
        weekly_capacity_hours: 40,
        max_concurrent_tasks: 2,
        is_available: true,
        current_focus: 'Traceability'
      }
    ];

    const githubIssues = [
      { number: 1, title: 'Task A', state: 'open', assignees: [{ login: 'sham-dev' }] },
      { number: 2, title: 'Task B', state: 'open', assignees: [{ login: 'sham-dev' }] },
      { number: 3, title: 'Task C', state: 'open', assignees: [{ login: 'sham-dev' }] }, // 3 open >= maxConcurrent 2 -> overloaded
      { number: 4, title: 'Task D', state: 'open', assignees: [{ login: 'external-contributor' }] } // No profile
    ];

    const evidenceByUser = {
      'sham-dev': {
        openAssignedIssuesCount: 3,
        openAssignedIssues: [{ number: 1 }, { number: 2 }, { number: 3 }]
      },
      'external-contributor': {
        openAssignedIssuesCount: 1,
        openAssignedIssues: [{ number: 4 }]
      }
    };

    const reports = generatePmReports({
      project,
      developerProfiles,
      githubIssues,
      evidenceByUser
    });

    const workload = reports.teamWorkload;
    assert.strictEqual(workload.totalMembers, 2);
    assert.strictEqual(workload.overloadedCount, 1);

    const dev = workload.members.find(m => m.username === 'sham-dev');
    assert.ok(dev.isOverloaded);
    assert.strictEqual(dev.workloadStatus, 'overloaded');
    assert.strictEqual(dev.openAssignedIssuesCount, 3);

    const ext = workload.members.find(m => m.username === 'external-contributor');
    assert.strictEqual(ext.workloadStatus, 'profile_missing');
    assert.strictEqual(ext.weeklyCapacityHours, null, 'Never invent capacity hours');
    assert.ok(ext.notice.includes('cannot be inferred from activity alone'));
  });

  await t.test('6. Stakeholder Update draft covers progress, risks, delays, and decisions required', () => {
    const changeRequests = [
      { change_id: 'CR-001', description: 'Extend sprint scope for audit compliance', status: 'under_review', requester: 'PM Lead' }
    ];

    const reports = generatePmReports({
      project,
      changeRequests
    });

    const update = reports.stakeholderUpdate;
    assert.ok(update.draftText);
    assert.ok(update.draftText.includes('Project Status Update: SHAM-MAX/GitHub-Kanban-Practice'));
    assert.ok(update.draftText.includes('CR-001'));
    assert.ok(update.draftText.includes('Decisions & Approvals Required'));
  });
});

test('PM Reports API Route Tests', async (t) => {
  await runMigrations();

  const originalEnv = { ...process.env };
  const testOwner = 'reports-test-org';
  const testRepo = 'reports-test-repo';
  const project = await projectStore.upsertProject({
    owner: testOwner,
    repository: testRepo,
    name: 'Reports Test',
    description: 'Testing reports route'
  });

  const pmUser = await upsertUser('gh-pm-reports-801', 'pmreportsuser');
  await setProjectRole(project.id, pmUser.id, 'Manager');

  const app = express();
  app.use(express.json());
  app.use('/api/pm/reports', reportsRouter);

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
    await db.query(`DELETE FROM pm_users WHERE id = $1`, [pmUser.id]).catch(() => {});

    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    for (const [key, value] of Object.entries(originalEnv)) {
      process.env[key] = value;
    }
  });

  await t.test('1. GET /api/pm/reports rejects unauthenticated requests with 401', async () => {
    const res = await fetch(`${baseUrl}/api/pm/reports?owner=${testOwner}&repo=${testRepo}`);
    assert.strictEqual(res.status, 401);
  });

  await t.test('2. GET /api/pm/reports authenticated request returns structured reports', async () => {
    const originalFetch = global.fetch;
    global.fetch = async (url, opts) => {
      if (url.includes('/issues')) {
        return {
          ok: true,
          json: async () => [
            { number: 1, title: 'Open Task', state: 'open' },
            { number: 2, title: 'Completed Task', state: 'closed' }
          ]
        };
      }
      if (url.includes('/pulls')) {
        return {
          ok: true,
          json: async () => []
        };
      }
      if (url.includes('/assignees') || url.includes('/contributors')) {
        return { ok: true, json: async () => [] };
      }
      return originalFetch(url, opts);
    };

    try {
      const sessionId = await createSession(pmUser.id);
      const res = await originalFetch(`${baseUrl}/api/pm/reports?owner=${testOwner}&repo=${testRepo}`, {
        headers: {
          Cookie: `relay_pm_session=${sessionId}`
        }
      });

      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.ok(data.reports);
      assert.ok(data.reports.projectStatusReport);
      assert.ok(data.reports.milestoneReport);
      assert.ok(data.reports.deliveryForecast);
      assert.ok(data.reports.teamWorkload);
      assert.ok(data.reports.stakeholderUpdate);
      assert.strictEqual(data.reports.projectStatusReport.metrics.totalIssues, 2);
      assert.strictEqual(data.context.owner, testOwner);
      assert.strictEqual(data.context.repo, testRepo);
    } finally {
      global.fetch = originalFetch;
    }
  });
});
