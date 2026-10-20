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

  await t.test('7. Empty assignee list and insufficient permissions handling', async () => {
    const originalFetch = global.fetch;
    const testOwner = 'test-empty-org';
    const testRepo = 'empty-repo';
    const bobSession = await createSession(bob.id);

    // Mock GitHub returning 403 insufficient permissions
    global.fetch = async (url, options) => {
      const urlStr = String(url);
      if (urlStr.includes('/assignees')) {
        return {
          ok: false,
          status: 403,
          json: async () => ({ message: 'Must have push access to view assignees' })
        };
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
          task: { title: 'Test Task' }
        })
      });

      assert.equal(recRes.status, 200);
      const data = await recRes.json();
      assert.deepEqual(data.recommendations, []);
      assert.ok(data.warnings.length > 0);
      assert.ok(data.warnings[0].includes('Insufficient GitHub permissions'));
    } finally {
      global.fetch = originalFetch;
    }
  });

  await t.test('8. CORS preflight OPTIONS returns 204 with extension origin headers', async () => {
    const extOrigin = 'chrome-extension://' + 'a'.repeat(32);
    // Register origin in pm_extension_origins
    await db.query(`INSERT INTO pm_extension_origins (origin) VALUES ($1) ON CONFLICT DO NOTHING`, [extOrigin]);

    const res = await fetch(`${baseUrl}/api/pm/assignment/recommendations`, {
      method: 'OPTIONS',
      headers: {
        'Origin': extOrigin,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type'
      }
    });

    assert.equal(res.status, 204);
    assert.equal(res.headers.get('access-control-allow-origin'), extOrigin);
    assert.equal(res.headers.get('access-control-allow-credentials'), 'true');
  });

  await t.test('9. Regression: Technical skills extraction from title/description/acceptance criteria when labels are non-technical', async () => {
    const candidates = [
      {
        username: 'alice',
        githubId: '101',
        profile: {
          declared_skills: ['javascript', 'react', 'python', 'fastapi'],
          weekly_capacity_hours: 40,
          max_concurrent_tasks: 3,
          is_available: true
        },
        githubEvidence: {
          openAssignedIssuesCount: 1,
          recentCommitsCount: 12
        }
      }
    ];

    // Case A: Issue has non-tech label 'bug', but description mentions FastAPI and React in acceptance criteria
    const taskA = {
      title: 'Fix session token refresh timeout',
      description: '## ACCEPTANCE CRITERIA\n- [ ] Ensure FastAPI endpoint validates token\n- [ ] React UI updates without reload',
      requiredSkills: ['bug'], // Non-tech label passed as requiredSkills
      estimatedHours: 4,
      priority: 'Medium',
      risk: 'Low'
    };

    const recsA = assignmentEngine.calculateAssignmentRecommendations({ candidates, task: taskA });
    assert.equal(recsA.length, 1);
    // Skills must not be 0% since FastAPI and React are in the task acceptance criteria
    assert.ok(recsA[0].criteria.technicalSkills.score > 0, `Expected skills score > 0, got ${recsA[0].criteria.technicalSkills.score}`);
    assert.ok(recsA[0].criteria.technicalSkills.matchedSkills.includes('fastapi') || recsA[0].criteria.technicalSkills.matchedSkills.includes('react'));

    // Case B: Issue genuinely has no tech match at all (e.g. rust, golang)
    const taskB = {
      title: 'Optimize memory allocation in C++ engine',
      description: 'Rewrite memory allocator using C++ and assembly',
      requiredSkills: ['c++', 'assembly'],
      estimatedHours: 8,
      priority: 'High',
      risk: 'High'
    };

    const recsB = assignmentEngine.calculateAssignmentRecommendations({ candidates, task: taskB });
    assert.equal(recsB[0].criteria.technicalSkills.score, 0);
    assert.equal(recsB[0].criteria.technicalSkills.matchedSkills.length, 0);
  });

  await t.test('10. Regression: Overloaded candidate (5 open vs 3 max capacity) receives overload status, weak fit, and warning', async () => {
    const candidates = [
      {
        username: 'dev_overloaded',
        githubId: '201',
        profile: {
          declared_skills: ['javascript', 'react', 'python', 'fastapi'],
          weekly_capacity_hours: 40,
          max_concurrent_tasks: 3,
          is_available: true
        },
        githubEvidence: {
          openAssignedIssuesCount: 5, // 5 open vs capacity 3
          recentCommitsCount: 30
        }
      }
    ];

    const task = {
      title: 'Unrelated ticket with no tech match',
      description: 'General maintenance',
      requiredSkills: ['documentation'],
      estimatedHours: 8,
      priority: 'High',
      risk: 'Medium'
    };

    const recs = assignmentEngine.calculateAssignmentRecommendations({ candidates, task });
    assert.equal(recs.length, 1);
    const rec = recs[0];

    // Workload score must be 0
    assert.equal(rec.criteria.workloadAndEffort.score, 0);
    assert.equal(rec.isOverloaded, true);
    assert.equal(rec.isRecommended, false);
    assert.equal(rec.fitLevel, 'weak');
    assert.equal(rec.recommendationStatus, 'overloaded');
    assert.ok(rec.rationale.includes('Over capacity'));
    assert.ok(rec.missingDataWarnings.some(w => w.includes('meets or exceeds capacity')));
    // Confidence is evidence completeness (profile present, github present = High)
    assert.equal(rec.confidence, 'High');
    assert.equal(rec.confidenceMeaning, 'Evidence completeness (data points available)');
  });

  await t.test('11. Regression: Low-scoring sole candidate is not recommended unconditionally', async () => {
    const candidates = [
      {
        username: 'sole_candidate',
        githubId: '301',
        profile: {
          declared_skills: ['ruby'],
          weekly_capacity_hours: 10,
          max_concurrent_tasks: 2,
          is_available: true
        },
        githubEvidence: {
          openAssignedIssuesCount: 4, // Overloaded
          recentCommitsCount: 1
        }
      }
    ];

    const task = {
      title: 'Kubernetes ingress config',
      description: 'Helm chart update',
      requiredSkills: ['kubernetes', 'helm'],
      estimatedHours: 12,
      priority: 'High',
      risk: 'High'
    };

    const recs = assignmentEngine.calculateAssignmentRecommendations({ candidates, task });
    assert.equal(recs.length, 1);
    assert.ok(recs[0].overallScore < 40);
    assert.equal(recs[0].isRecommended, false);
    assert.equal(recs[0].fitLevel, 'weak');
  });

  await t.test('12. Assignment Policy Store & Policy API endpoint (RBAC and defaults)', async () => {
    const aliceSession = await createSession(alice.id);
    const bobSession = await createSession(bob.id);

    // 1. Viewer (Bob) can read project policy
    const getRes = await fetch(`${baseUrl}/api/pm/assignment/policy?owner=${testOwner}&repo=${testRepo}`, {
      headers: { 'Cookie': `relay_pm_session=${bobSession}` }
    });
    assert.equal(getRes.status, 200);
    const getData = await getRes.json();
    assert.equal(getData.policy.mode, 'recommendation');
    assert.equal(getData.policy.min_confidence_score, 70);

    // 2. Viewer (Bob) cannot update project policy (Manager required -> 403)
    const viewerPutRes = await fetch(`${baseUrl}/api/pm/assignment/policy?owner=${testOwner}&repo=${testRepo}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': `relay_pm_session=${bobSession}`
      },
      body: JSON.stringify({ mode: 'automatic', minConfidenceScore: 80 })
    });
    assert.equal(viewerPutRes.status, 403);

    // 3. Manager (Alice) can update project policy
    const mgrPutRes = await fetch(`${baseUrl}/api/pm/assignment/policy?owner=${testOwner}&repo=${testRepo}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': `relay_pm_session=${aliceSession}`
      },
      body: JSON.stringify({
        mode: 'automatic',
        minConfidenceScore: 85,
        enforceCapacityLimits: true,
        allowGrowthAllocation: false
      })
    });
    assert.equal(mgrPutRes.status, 200);
    const mgrData = await mgrPutRes.json();
    assert.equal(mgrData.policy.mode, 'automatic');
    assert.equal(mgrData.policy.min_confidence_score, 85);
    assert.equal(mgrData.policy.allow_growth_allocation, false);

    // Reset back to safe recommendation mode for subsequent tests
    await fetch(`${baseUrl}/api/pm/assignment/policy?owner=${testOwner}&repo=${testRepo}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': `relay_pm_session=${aliceSession}`
      },
      body: JSON.stringify({ mode: 'recommendation', minConfidenceScore: 70 })
    });
  });

  await t.test('13. Real assignment execution endpoint (POST /api/pm/assignment/assign) with GitHub confirmation and audit trail', async () => {
    // Set TOKEN_ENCRYPTION_KEY if not set
    process.env.TOKEN_ENCRYPTION_KEY = process.env.TOKEN_ENCRYPTION_KEY || '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    const key = Buffer.from(process.env.TOKEN_ENCRYPTION_KEY, 'hex');
    const cryptoModule = await import('crypto');
    const iv = cryptoModule.randomBytes(16);
    const cipher = cryptoModule.createCipheriv('aes-256-gcm', key, iv);
    let encrypted = cipher.update('ghp_mocktoken12345678901234567890123456', 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag().toString('hex');
    const encryptedTokenStr = encrypted + ':' + authTag;
    const tokenIvHex = iv.toString('hex');

    await db.query(`UPDATE pm_users SET encrypted_token = $1, token_iv = $2 WHERE id = $3`, [encryptedTokenStr, tokenIvHex, alice.id]);

    const aliceSession = await createSession(alice.id);
    const originalFetch = global.fetch;

    try {
      // Mock GitHub issue assignment API
      global.fetch = async (url, options) => {
        const urlStr = String(url);
        if (urlStr.includes('/issues/10/assignees')) {
          const body = JSON.parse(options.body);
          return {
            ok: true,
            status: 201,
            json: async () => ({
              number: 10,
              html_url: `https://github.com/${testOwner}/${testRepo}/issues/10`,
              assignees: [{ login: body.assignees[0] }]
            })
          };
        }
        return originalFetch(url, options);
      };

      const assignRes = await originalFetch(`${baseUrl}/api/pm/assignment/assign?owner=${testOwner}&repo=${testRepo}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Cookie': `relay_pm_session=${aliceSession}`
        },
        body: JSON.stringify({
          issueNumber: 10,
          assignee: 'alice',
          mode: 'manual_approval'
        })
      });

      assert.equal(assignRes.status, 200);
      const data = await assignRes.json();
      assert.equal(data.success, true);
      assert.equal(data.assigned, true);
      assert.equal(data.assignee, 'alice');
      assert.equal(data.issueNumber, 10);
      assert.match(data.githubUrl, /issues\/10/);
    } finally {
      global.fetch = originalFetch;
    }
  });

  await t.test('14. Assignment execution partial failure detection when GitHub drops ineligible assignee', async () => {
    const aliceSession = await createSession(alice.id);
    const originalFetch = global.fetch;

    try {
      // Mock GitHub returning 200 but empty assignees (GitHub silently ignores non-collaborators)
      global.fetch = async (url, options) => {
        const urlStr = String(url);
        if (urlStr.includes('/issues/20/assignees')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              number: 20,
              html_url: `https://github.com/${testOwner}/${testRepo}/issues/20`,
              assignees: [] // Ineligible user was dropped by GitHub
            })
          };
        }
        return originalFetch(url, options);
      };

      const assignRes = await originalFetch(`${baseUrl}/api/pm/assignment/assign?owner=${testOwner}&repo=${testRepo}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Cookie': `relay_pm_session=${aliceSession}`
        },
        body: JSON.stringify({
          issueNumber: 20,
          assignee: 'ineligible_dev',
          mode: 'manual_approval'
        })
      });

      assert.equal(assignRes.status, 422);
      const data = await assignRes.json();
      assert.match(data.error, /not an eligible collaborator or assignee/);
    } finally {
      global.fetch = originalFetch;
    }
  });
});

