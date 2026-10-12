import test from 'node:test';
import assert from 'node:assert/strict';
import db from '../lib/db.js';
import { runMigrations, getMigrationStatus } from '../lib/migrator.js';
import projectStore from '../lib/project-store.js';
import conversationStore from '../lib/conversation-store.js';
import { assistantError } from '../lib/assistant.js';
import { newDb } from 'pg-mem';
import crypto from 'node:crypto';

/**
 * Creates an isolated in-memory test database and pool.
 */
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

test('Database Connection Manager & Health Checks', async (t) => {
  const { pool } = createIsolatedTestDatabase();
  db.setPool(pool);

  await t.test('1. healthCheck reports ok and latency', async () => {
    const health = await db.healthCheck();
    assert.equal(health.ok, true);
    assert.equal(typeof health.latencyMs, 'number');
    assert.ok(health.latencyMs >= 0);
  });

  await t.test('2. executes parameterized queries cleanly', async () => {
    const res = await db.query('SELECT $1::text AS msg, $2::int AS count', ['relay', 42]);
    assert.equal(res.rows.length, 1);
    assert.equal(res.rows[0].msg, 'relay');
    assert.equal(res.rows[0].count, 42);
  });

  await t.test('3. client acquisition and release on dedicated pool client', async () => {
    const client = await db.getClient();
    assert.ok(client);
    assert.equal(typeof client.query, 'function');
    assert.equal(typeof client.release, 'function');
    const res = await client.query('SELECT 123 AS num');
    assert.equal(res.rows[0].num, 123);
    client.release();
  });
});

test('Versioned Database Migrations', async (t) => {
  const { pool } = createIsolatedTestDatabase();
  db.setPool(pool);

  await t.test('1. runMigrations applies pending migrations in order', async () => {
    const initialStatus = await getMigrationStatus({ pool });
    assert.ok(initialStatus.length > 0);
    assert.equal(initialStatus[0].applied, false);

    const result = await runMigrations({ pool });
    assert.ok(result.applied.length > 0);
    assert.equal(result.applied[0].version, '001');

    const updatedStatus = await getMigrationStatus({ pool });
    assert.equal(updatedStatus[0].applied, true);
    assert.ok(updatedStatus[0].applied_at instanceof Date);
  });

  await t.test('2. runMigrations is idempotent when executed again', async () => {
    const secondRun = await runMigrations({ pool });
    assert.equal(secondRun.applied.length, 0);
    assert.equal(secondRun.skipped.length, secondRun.total);
  });

  await t.test('3. runMigrations detects modified migration checksums', async () => {
    // Corrupt the checksum for the first migration
    await pool.query("UPDATE schema_migrations SET checksum = 'invalid-hash' WHERE version = '001'");

    await assert.rejects(
      runMigrations({ pool }),
      /Migration checksum mismatch/
    );

    // Revert to NULL to simulate a legacy migration without a checksum (backward compatibility)
    await pool.query("UPDATE schema_migrations SET checksum = NULL WHERE version = '001'");

    // Now it should pass without error
    const legacyRun = await runMigrations({ pool });
    assert.equal(legacyRun.applied.length, 0);
  });

  await t.test('4. runMigrations acquires and releases pg_advisory_lock', async () => {
    const originalConnect = pool.connect.bind(pool);
    let lockRequested = false;
    let unlockRequested = false;

    const wasMemoryPool = pool.__isMemoryPool;
    pool.__isMemoryPool = false; // Trick migrator into using locks
    let clientRef = null;
    let originalQueryRef = null;

    try {
      pool.connect = async () => {
        clientRef = await originalConnect();
        originalQueryRef = clientRef.query.bind(clientRef);
        clientRef.query = async (text, params) => {
          if (text.includes('pg_advisory_lock(')) {
            lockRequested = true;
            return { rows: [] }; // Mock success, bypass pg-mem error
          }
          if (text.includes('pg_advisory_unlock(')) {
            unlockRequested = true;
            return { rows: [] }; // Mock success
          }
          return originalQueryRef(text, params);
        };
        return clientRef;
      };

      await runMigrations({ pool });

      assert.ok(lockRequested, 'pg_advisory_lock was not requested');
      assert.ok(unlockRequested, 'pg_advisory_unlock was not requested');
    } finally {
      pool.connect = originalConnect;
      pool.__isMemoryPool = wasMemoryPool;
      if (clientRef && originalQueryRef) {
        clientRef.query = originalQueryRef;
      }
    }
  });

  await t.test('5. lock-acquisition errors prevent migration SQL from executing', async () => {
    const originalConnect = pool.connect.bind(pool);
    let migrationSqlExecuted = false;

    const wasMemoryPool = pool.__isMemoryPool;
    pool.__isMemoryPool = false; // Trick migrator into using locks
    let clientRef = null;
    let originalQueryRef = null;

    try {
      pool.connect = async () => {
        clientRef = await originalConnect();
        originalQueryRef = clientRef.query.bind(clientRef);
        clientRef.query = async (text, params) => {
          if (text.includes('pg_advisory_lock(')) {
            throw new Error('Simulated lock failure');
          }
          if (text.includes('CREATE TABLE') || text.includes('INSERT INTO')) {
            migrationSqlExecuted = true;
          }
          return originalQueryRef(text, params);
        };
        return clientRef;
      };

      await assert.rejects(
        runMigrations({ pool }),
        /Simulated lock failure/
      );

      assert.equal(migrationSqlExecuted, false, 'Migration SQL should not execute if lock fails');
    } finally {
      pool.connect = originalConnect;
      pool.__isMemoryPool = wasMemoryPool;
      if (clientRef && originalQueryRef) {
        clientRef.query = originalQueryRef;
      }
    }
  });

  await t.test('6. pg_advisory_unlock is requested even if migration SQL fails', async () => {
    const originalConnect = pool.connect.bind(pool);
    let lockRequested = false;
    let unlockRequested = false;

    const wasMemoryPool = pool.__isMemoryPool;
    pool.__isMemoryPool = false; // Trick migrator into using locks
    let clientRef = null;
    let originalQueryRef = null;

    try {
      pool.connect = async () => {
        clientRef = await originalConnect();
        originalQueryRef = clientRef.query.bind(clientRef);
        clientRef.query = async (text, params) => {
          if (text.includes('pg_advisory_lock(')) {
            lockRequested = true;
            return { rows: [] }; // Mock success
          }
          if (text.includes('pg_advisory_unlock(')) {
            unlockRequested = true;
            return { rows: [] }; // Mock success
          }
          // Simulate SQL failure when migrations are being executed
          if (text.includes('SELECT 1 FROM information_schema.tables')) {
            throw new Error('Simulated SQL failure');
          }
          return originalQueryRef(text, params);
        };
        return clientRef;
      };

      await assert.rejects(
        runMigrations({ pool }),
        /Simulated SQL failure/
      );

      assert.ok(lockRequested, 'pg_advisory_lock was not requested');
      assert.ok(unlockRequested, 'pg_advisory_unlock was not requested after SQL failure');
    } finally {
      pool.connect = originalConnect;
      pool.__isMemoryPool = wasMemoryPool;
      if (clientRef && originalQueryRef) {
        clientRef.query = originalQueryRef;
      }
    }
  });

  await t.test('7. unlock failure triggers client.release with an error (which instructs pg pool to destroy the connection)', async () => {
    const originalConnect = pool.connect.bind(pool);
    let releaseCalledWithError = false;

    const wasMemoryPool = pool.__isMemoryPool;
    pool.__isMemoryPool = false; // Trick migrator into using locks
    let clientRef = null;
    let originalQueryRef = null;
    let originalReleaseRef = null;

    try {
      pool.connect = async () => {
        clientRef = await originalConnect();
        originalQueryRef = clientRef.query.bind(clientRef);

        clientRef.query = async (text, params) => {
          if (text.includes('pg_advisory_lock(')) {
            return { rows: [] }; // Mock success
          }
          if (text.includes('pg_advisory_unlock(')) {
            throw new Error('Simulated unlock failure');
          }
          return originalQueryRef(text, params);
        };

        originalReleaseRef = clientRef.release.bind(clientRef);
        clientRef.release = (err) => {
          if (err && err.message.includes('Simulated unlock failure')) {
            releaseCalledWithError = true;
          }
          return originalReleaseRef(err); // Note: pg pool handles truthy err by destroying client; pg-mem just mocks this
        };

        return clientRef;
      };

      const result = await runMigrations({ pool });

      assert.ok(result, 'runMigrations should return a valid result object');
      assert.equal(typeof result.total, 'number', 'runMigrations should complete the mocked migration path');
      assert.ok(releaseCalledWithError, 'Client should be released with an error parameter (mocked pg pool destruction behavior)');
    } finally {
      pool.connect = originalConnect;
      pool.__isMemoryPool = wasMemoryPool;
      if (clientRef && originalQueryRef && originalReleaseRef) {
        clientRef.query = originalQueryRef;
        clientRef.release = originalReleaseRef;
      }
    }
  });
});

test('Project Identity Persistence Store', async (t) => {
  const { pool } = createIsolatedTestDatabase();
  await runMigrations({ pool });
  db.setPool(pool);

  await t.test('1. upsertProject inserts a new project identity', async () => {
    const project = await projectStore.upsertProject({
      owner: 'SHAM-MAX',
      repository: 'test-relay-repo',
      name: 'Test Relay',
      description: 'Initial repo description'
    });

    assert.ok(project.id);
    assert.equal(project.github_owner, 'SHAM-MAX');
    assert.equal(project.github_repo, 'test-relay-repo');
    assert.equal(project.description, 'Initial repo description');
  });

  await t.test('2. upsertProject updates existing project on conflict without creating duplicate', async () => {
    const updated = await projectStore.upsertProject({
      owner: 'SHAM-MAX',
      repository: 'test-relay-repo',
      name: 'Test Relay',
      description: 'Updated repo description'
    });

    const check = await db.query('SELECT COUNT(*) AS total FROM pm_projects WHERE github_owner = $1 AND github_repo = $2', ['SHAM-MAX', 'test-relay-repo']);
    assert.equal(Number(check.rows[0].total), 1);
    assert.equal(updated.description, 'Updated repo description');
  });

  await t.test('3. getProject retrieves project by owner and repository', async () => {
    const fetched = await projectStore.getProject('SHAM-MAX', 'test-relay-repo');
    assert.ok(fetched);
    assert.equal(fetched.github_owner, 'SHAM-MAX');
    assert.equal(fetched.github_repo, 'test-relay-repo');
  });

  await t.test('4. rejects invalid repository and owner formats', async () => {
    await assert.rejects(
      projectStore.upsertProject({ owner: 'invalid..owner!', repository: 'repo' }),
      (err) => err.code === 'INVALID_PROJECT_OWNER' && err.status === 400
    );

    await assert.rejects(
      projectStore.upsertProject({ owner: 'valid-owner', repository: 'repo with spaces' }),
      (err) => err.code === 'INVALID_PROJECT_REPO' && err.status === 400
    );
  });
});

test('Conversation Storage & History Preservation', async (t) => {
  const { pool } = createIsolatedTestDatabase();
  await runMigrations({ pool });
  db.setPool(pool);

  const memberId = 'member-test-01';

  await t.test('1. returns empty array for new conversation', async () => {
    const history = await conversationStore.getConversationHistory(memberId);
    assert.deepEqual(history, []);
  });

  await t.test('2. appends turns and retrieves in chronological order', async () => {
    await conversationStore.appendConversationTurn(memberId, null, {
      userMessage: 'What is the sprint goal?',
      assistantReply: 'The sprint goal is backend persistence.',
      model: 'gemini-3.8-flash'
    });

    const history = await conversationStore.getConversationHistory(memberId);
    assert.equal(history.length, 2);
    assert.deepEqual(history[0], { role: 'user', content: 'What is the sprint goal?' });
    assert.deepEqual(history[1], { role: 'assistant', content: 'The sprint goal is backend persistence.' });
  });

  await t.test('3. caps message history at requested limit (default 10 items)', async () => {
    // Add 6 more turns (12 messages total)
    for (let i = 1; i <= 6; i++) {
      await conversationStore.appendConversationTurn(memberId, null, {
        userMessage: `Turn ${i} user`,
        assistantReply: `Turn ${i} assistant`
      });
    }

    const history = await conversationStore.getConversationHistory(memberId, null, 10);
    assert.equal(history.length, 10);
    // The most recent assistant reply should be the last message
    assert.equal(history[history.length - 1].content, 'Turn 6 assistant');
  });

  await t.test('4. conversations remain isolated across different members', async () => {
    const otherMemberHistory = await conversationStore.getConversationHistory('member-other');
    assert.deepEqual(otherMemberHistory, []);
  });
});

test('Persistence Across Simulated Service Restart', async () => {
  // Use the same underlying memDb instance to simulate a service restart
  const { memDb, pool: pool1 } = createIsolatedTestDatabase();
  await runMigrations({ pool: pool1 });
  db.setPool(pool1);

  // 1. Create project and conversation before shutdown
  const project = await projectStore.upsertProject({
    owner: 'restart-owner',
    repository: 'restart-repo',
    description: 'Saved before restart'
  });

  await conversationStore.appendConversationTurn('user-restart', project.id, {
    userMessage: 'Remember this message across restart',
    assistantReply: 'I will remember it.'
  });

  // 2. Simulate shutdown: close connection pool
  await db.closePool();

  // 3. Simulate startup: re-open pool to the same database
  const memPg = memDb.adapters.createPg();
  const pool2 = new memPg.Pool();
  pool2.__isMemoryPool = true;
  db.setPool(pool2);

  // 4. Verify data survived the restart
  const restoredProject = await projectStore.getProject('restart-owner', 'restart-repo');
  assert.ok(restoredProject);
  assert.equal(restoredProject.id, project.id);
  assert.equal(restoredProject.description, 'Saved before restart');

  const restoredHistory = await conversationStore.getConversationHistory('user-restart', project.id);
  assert.equal(restoredHistory.length, 2);
  assert.equal(restoredHistory[0].content, 'Remember this message across restart');
  assert.equal(restoredHistory[1].content, 'I will remember it.');
});

test('Database Failure Handling & Error Safety', async (t) => {
  await t.test('1. throws when attempting query on broken pool without losing data silently', async () => {
    const brokenPool = {
      async query() {
        throw new Error('Connection terminated unexpectedly');
      },
      async connect() {
        throw new Error('Connection pool exhausted');
      }
    };
    db.setPool(brokenPool);

    await assert.rejects(
      projectStore.upsertProject({ owner: 'any', repository: 'repo' }),
      (err) => err.code === 'PROJECT_PERSISTENCE_FAILED' && err.status === 500
    );

    await assert.rejects(
      conversationStore.appendConversationTurn('user', null, { userMessage: 'hi', assistantReply: 'hello' }),
      (err) => err.code === 'CONVERSATION_PERSISTENCE_FAILED' && err.status === 500
    );
  });

  await t.test('2. assistantError converts database errors into clean 500 responses', () => {
    const dbErr = Object.assign(new Error('Failed to persist project identity: connection refused'), {
      status: 500,
      code: 'PROJECT_PERSISTENCE_FAILED'
    });

    const safe = assistantError(dbErr);
    assert.equal(safe.status, 500);
    assert.equal(safe.body.code, 'PROJECT_PERSISTENCE_FAILED');
    assert.ok(safe.body.error.includes('Failed to persist project identity'));
  });
});
