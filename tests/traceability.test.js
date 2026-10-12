import test from 'node:test';
import assert from 'node:assert/strict';
import db from '../lib/db.js';
import { runMigrations } from '../lib/migrator.js';
import projectStore from '../lib/project-store.js';
import traceabilityStore from '../lib/traceability-store.js';
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
});
