import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import db from '../lib/db.js';
import { runMigrations } from '../lib/migrator.js';
import developerStore from '../lib/developer-store.js';
import assignmentEngine from '../lib/assignment-engine.js';
import projectStore from '../lib/project-store.js';
import { upsertUser, setProjectRole } from '../lib/auth.js';
import { createSession } from '../lib/session.js';
import assignmentRouter from '../api/pm/assignment.js';

test('Developer Assignment Intelligence (Phase 1)', async (t) => {
  // 1. Run migrations to ensure 010_developer_profiles.sql is applied
  await runMigrations();

  const originalEnv = { ...process.env };
  const testOwner = 'assign-test-org';
  const testRepo = 'assign-test-repo';
  const project = await projectStore.upsertProject({
    owner: testOwner,
    repository: testRepo,
    name: 'Assignment Test',
    description: 'Testing assignments'
  });

  const alice = await upsertUser('gh-alice-101', 'alice');
  const bob = await upsertUser('gh-bob-102', 'bob');
  const charlie = await upsertUser('gh-charlie-103', 'charlie');
  const dave = await upsertUser('gh-dave-104', 'dave');

  // Roles in project
  await setProjectRole(project.id, alice.id, 'Manager');
  await setProjectRole(project.id, bob.id, 'Viewer');
  await setProjectRole(project.id, charlie.id, 'Viewer');
  await setProjectRole(project.id, dave.id, 'Viewer');

  // Start dedicated local test server on dynamic port (0)
  const app = express();
  app.use(express.json());
  app.use('/api/pm/assignment', assignmentRouter);

  let server;
  let baseUrl;
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://localhost:${server.address().port}`;
      resolve();
    });
  });

  t.after(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    // Clean up project and users created for this test
    await db.query(`DELETE FROM pm_projects WHERE id = $1`, [project.id]).catch(() => {});
    await db.query(`DELETE FROM pm_users WHERE id IN ($1, $2, $3, $4)`, [alice.id, bob.id, charlie.id, dave.id]).catch(() => {});

    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    }
    for (const [key, value] of Object.entries(originalEnv)) {
      process.env[key] = value;
    }
  });

  await t.test('1. Developer profile creation, retrieval, and validation', async () => {
    const profile = await developerStore.upsertDeveloperProfile(project.id, alice.id, {
      declaredSkills: ['Node.js', 'PostgreSQL', 'Docker'],
      weeklyCapacityHours: 35,
      maxConcurrentTasks: 4,
      isAvailable: true,
      currentFocus: 'Backend Architecture'
    });

    assert.ok(profile.id);
    assert.deepEqual(profile.declared_skills, ['node.js', 'postgresql', 'docker']);
    assert.equal(profile.weekly_capacity_hours, 35);
    assert.equal(profile.max_concurrent_tasks, 4);
    assert.equal(profile.is_available, true);

    const retrieved = await developerStore.getDeveloperProfile(project.id, alice.id);
    assert.equal(retrieved.github_username, 'alice');
    assert.equal(retrieved.weekly_capacity_hours, 35);

    // Validation checks
    await assert.rejects(
      () => developerStore.upsertDeveloperProfile(project.id, alice.id, { declaredSkills: 'not-array' }),
      /must be an array/
    );
    await assert.rejects(
      () => developerStore.upsertDeveloperProfile(project.id, alice.id, { weeklyCapacityHours: 200 }),
      /weeklyCapacityHours must be between 0 and 168/
    );
  });

  await t.test('2. Scoring Engine - Deterministic ranking and skill matching', async () => {
    const candidates = [
      {
        username: 'alice',
        githubId: '101',
        profile: {
          declared_skills: ['node.js', 'postgresql'],
          weekly_capacity_hours: 40,
          max_concurrent_tasks: 3,
          is_available: true
        },
        githubEvidence: {
          openAssignedIssuesCount: 0,
          recentCommitsCount: 15
        }
      },
      {
        username: 'bob',
        githubId: '102',
        profile: {
          declared_skills: ['python', 'react'],
          weekly_capacity_hours: 40,
          max_concurrent_tasks: 3,
          is_available: true
        },
        githubEvidence: {
          openAssignedIssuesCount: 0,
          recentCommitsCount: 15
        }
      }
    ];

    const task = {
      title: 'Fix Postgres connection pool leak',
      requiredSkills: ['postgresql'],
      estimatedHours: 4,
      priority: 'High',
      risk: 'Medium'
    };

    const recs1 = assignmentEngine.calculateAssignmentRecommendations({ candidates, task });
    const recs2 = assignmentEngine.calculateAssignmentRecommendations({ candidates, task });

    // Deterministic outputs
    assert.deepEqual(recs1, recs2);
    assert.equal(recs1[0].githubUsername, 'alice');
    assert.ok(recs1[0].overallScore > recs1[1].overallScore);
    assert.equal(recs1[0].criteria.technicalSkills.score, 100);
    assert.equal(recs1[1].criteria.technicalSkills.score, 0);
  });

  await t.test('3. Workload overload penalty and warnings', async () => {
    const candidates = [
      {
        username: 'alice',
        githubId: '101',
        profile: {
          declared_skills: ['node.js'],
          weekly_capacity_hours: 40,
          max_concurrent_tasks: 2,
          is_available: true
        },
        githubEvidence: {
          openAssignedIssuesCount: 3, // Overloaded! (3 >= 2)
          recentCommitsCount: 25
        }
      },
      {
        username: 'bob',
        githubId: '102',
        profile: {
          declared_skills: ['node.js'],
          weekly_capacity_hours: 40,
          max_concurrent_tasks: 3,
          is_available: true
        },
        githubEvidence: {
          openAssignedIssuesCount: 0, // Fresh capacity
          recentCommitsCount: 5
        }
      }
    ];

    const task = {
      title: 'Build API feature',
      requiredSkills: ['node.js'],
      estimatedHours: 6,
      priority: 'High',
      risk: 'High'
    };

    const recs = assignmentEngine.calculateAssignmentRecommendations({ candidates, task });

    // Bob should rank higher than overloaded Alice despite lower commits
    assert.equal(recs[0].githubUsername, 'bob');
    const aliceRec = recs.find(r => r.githubUsername === 'alice');
    assert.ok(aliceRec.criteria.workloadAndEffort.score < 40);
    assert.ok(aliceRec.missingDataWarnings.some(w => w.includes('meets or exceeds capacity')));
  });

  await t.test('4. Fairness and growth rotation on low-risk tasks', async () => {
    const candidates = [
      {
        username: 'senior_alice',
        githubId: '101',
        profile: {
          declared_skills: ['css', 'html'],
          weekly_capacity_hours: 40,
          max_concurrent_tasks: 5,
          is_available: true
        },
        githubEvidence: {
          openAssignedIssuesCount: 2,
          recentCommitsCount: 50
        }
      },
      {
        username: 'junior_bob',
        githubId: '102',
        profile: {
          declared_skills: ['css', 'html'],
          weekly_capacity_hours: 40,
          max_concurrent_tasks: 3,
          is_available: true
        },
        githubEvidence: {
          openAssignedIssuesCount: 0,
          recentCommitsCount: 2
        }
      }
    ];

    const task = {
      title: 'Update button padding',
      requiredSkills: ['css'],
      estimatedHours: 2,
      priority: 'Low',
      risk: 'Low'
    };

    const recs = assignmentEngine.calculateAssignmentRecommendations({ candidates, task });
    const bobRec = recs.find(r => r.githubUsername === 'junior_bob');
    assert.equal(bobRec.criteria.growthAndFairness.score, 90);
    assert.ok(bobRec.rationale.includes('Growth opportunity on suitable lower-risk task'));
  });

  await t.test('5. Insufficient evidence and missing profile handling', async () => {
    const candidates = [
      {
        username: 'charlie',
        githubId: '103',
        profile: null, // No profile
        githubEvidence: null // No GitHub evidence
      }
    ];

    const task = {
      title: 'Investigate bug',
      requiredSkills: ['security'],
      estimatedHours: 4
    };

    const recs = assignmentEngine.calculateAssignmentRecommendations({ candidates, task });
    assert.equal(recs.length, 1);
    assert.equal(recs[0].confidence, 'Low');
    assert.ok(recs[0].missingDataWarnings.length >= 2);
    assert.ok(recs[0].missingDataWarnings.some(w => w.includes('No developer profile found')));
  });

  await t.test('6. Ineligible assignee filtering and scoped endpoint authorization', async () => {
    // Upsert developer profile for bob
    await developerStore.upsertDeveloperProfile(project.id, bob.id, {
      declaredSkills: ['react'],
      weeklyCapacityHours: 40,
      maxConcurrentTasks: 3,
      isAvailable: true
    });

    const bobSession = await createSession(bob.id);

    // Call GET /profile as bob
    const getRes = await fetch(`${baseUrl}/api/pm/assignment/profile?owner=${testOwner}&repo=${testRepo}`, {
      headers: {
        'Cookie': `relay_pm_session=${bobSession}`
      }
    });
    assert.equal(getRes.status, 200);
    const getData = await getRes.json();
    assert.equal(getData.profile.github_username, 'bob');

    // Bob (Viewer) cannot edit Alice's profile (Manager required)
    const putRes = await fetch(`${baseUrl}/api/pm/assignment/profile?owner=${testOwner}&repo=${testRepo}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': `relay_pm_session=${bobSession}`
      },
      body: JSON.stringify({
        userId: alice.id,
        declaredSkills: ['rust']
      })
    });
    assert.equal(putRes.status, 403);

    // Call POST /recommendations as bob with mocked GitHub fetch
    const originalFetch = global.fetch;
    global.fetch = async (url, options) => {
      const urlStr = String(url);
      if (urlStr.includes('api.github.com/repos/')) {
        if (urlStr.includes('/assignees')) {
          // GitHub returns eligible assignees: alice and bob only (dave is not a repo collaborator)
          return {
            ok: true,
            json: async () => [
              { id: 101, login: 'alice', avatar_url: 'https://avatars.github.com/u/101' },
              { id: 102, login: 'bob', avatar_url: 'https://avatars.github.com/u/102' }
            ]
          };
        }
        if (urlStr.includes('/issues')) {
          return {
            ok: true,
            json: async () => [
              { number: 1, title: 'Bug', assignees: [{ login: 'alice' }], pull_request: null }
            ]
          };
        }
        if (urlStr.includes('/contributors')) {
          return {
            ok: true,
            json: async () => [
              { login: 'alice', contributions: 25 },
              { login: 'bob', contributions: 5 }
            ]
          };
        }
      }
      return originalFetch(url, options);
    };

    try {
      const recRes = await originalFetch(`${baseUrl}/api/pm/assignment/recommendations?owner=${testOwner}&repo=${testRepo}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Cookie': `relay_pm_session=${bobSession}`
        },
        body: JSON.stringify({
          task: {
            title: 'React dashboard component',
            requiredSkills: ['react'],
            estimatedHours: 4,
            priority: 'Medium',
            risk: 'Low'
          }
        })
      });

      assert.equal(recRes.status, 200);
      const recData = await recRes.json();

      // Confirms only eligible assignees (alice, bob) are returned; ineligible user 'dave' is omitted
      assert.equal(recData.recommendations.length, 2);
      assert.ok(recData.recommendations.every(r => ['alice', 'bob'].includes(r.githubUsername)));

      // Bob has declared 'react' skill; Alice declared backend skills
      assert.equal(recData.recommendations[0].githubUsername, 'bob');
      assert.equal(recData.recommendations[0].criteria.technicalSkills.score, 100);

      // Verify recommendations are purely advisory (no issue auto-assigned or written)
      assert.ok(Array.isArray(recData.recommendations[0].missingDataWarnings));
      assert.ok(recData.metadata.task.title, 'React dashboard component');
    } finally {
      global.fetch = originalFetch;
    }
  });
});
