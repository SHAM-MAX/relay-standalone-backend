import test from 'node:test';
import assert from 'node:assert/strict';
import db from '../lib/db.js';
import { runMigrations } from '../lib/migrator.js';
import projectStore from '../lib/project-store.js';
import traceabilityStore from '../lib/traceability-store.js';
import scheduleEngine from '../lib/schedule-engine.js';
import milestoneStore from '../lib/milestone-store.js';
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

test('Schedule and Milestones (Phase 3)', async (t) => {
  const { pool } = createIsolatedTestDatabase();
  db.setPool(pool);
  await runMigrations({ pool });

  let projectId;

  await t.test('1. Setup project', async () => {
    const project = await projectStore.upsertProject({
      owner: 'schedule-owner',
      repository: 'schedule-repo',
      description: 'Schedule test'
    });
    projectId = project.id;
    assert.ok(projectId);
  });

  let milestoneId;

  await t.test('2. Create Milestone', async () => {
    const ms = await milestoneStore.createMilestone(projectId, 'V1 Release', 'First release', new Date());
    assert.ok(ms.id);
    assert.equal(ms.milestone_id, 'MS-001');
    milestoneId = ms.id;
  });

  let task1, task2, task3;

  await t.test('3. Create Work Items and Estimates', async () => {
    const req = await traceabilityStore.createRequirement(projectId, 'Req 1', 'Desc');
    task1 = await traceabilityStore.createWorkItem(projectId, req.id, 'task', 'Task A', 'Desc');
    task2 = await traceabilityStore.createWorkItem(projectId, req.id, 'task', 'Task B', 'Desc');
    task3 = await traceabilityStore.createWorkItem(projectId, req.id, 'task', 'Task C', 'Desc');

    // Update estimates and milestone assignment
    const client = await db.getClient();
    await client.query('UPDATE pm_work_items SET estimated_duration = 2, milestone_id = $1 WHERE id = $2', [milestoneId, task1.id]);
    await client.query('UPDATE pm_work_items SET estimated_duration = 3, milestone_id = $1 WHERE id = $2', [milestoneId, task2.id]);
    await client.query('UPDATE pm_work_items SET estimated_duration = 4, milestone_id = $1 WHERE id = $2', [milestoneId, task3.id]);
    client.release();
  });

  await t.test('4. Add Dependencies and Calculate Schedule', async () => {
    await scheduleEngine.addDependency(task1.id, task2.id);
    await scheduleEngine.addDependency(task1.id, task3.id);
    await scheduleEngine.addDependency(task2.id, task3.id);

    // T1 -> T2 -> T3
    // T1(2) -> T2(3) -> T3(4). Total duration = 9. Critical path is T1 -> T2 -> T3.
    // T1 -> T3 also exists, but is not critical path since T2 takes longer.

    const { scheduleId, scheduleItems } = await scheduleEngine.calculateSchedule(projectId, false);
    assert.ok(scheduleId);
    assert.equal(scheduleItems.length, 3);

    const s1 = scheduleItems.find(i => i.work_item_id === task1.id);
    const s2 = scheduleItems.find(i => i.work_item_id === task2.id);
    const s3 = scheduleItems.find(i => i.work_item_id === task3.id);

    assert.equal(s1.early_finish, 2);
    assert.equal(s2.early_finish, 5);
    assert.equal(s3.early_finish, 9);

    assert.equal(s1.is_critical, true);
    assert.equal(s2.is_critical, true);
    assert.equal(s3.is_critical, true);
  });

  await t.test('5. Reject Circular Dependencies', async () => {
    // Add cycle: T3 -> T1
    await assert.rejects(
      scheduleEngine.addDependency(task3.id, task1.id),
      /Circular dependency detected/
    );
  });

  await t.test('6. Milestone Health Calculation', async () => {
    const healthList = await milestoneStore.getMilestoneHealth(projectId);
    assert.equal(healthList.length, 1);
    const msHealth = healthList[0];
    assert.equal(msHealth.milestone_id, 'MS-001');
    assert.equal(msHealth.total_items, 3);
    assert.equal(msHealth.draft_items, 3);
    assert.equal(msHealth.health, 'on_track'); // No completed items, but total != 0

    // Complete a task
    const client = await db.getClient();
    await client.query('UPDATE pm_work_items SET status = $1 WHERE id = $2', ['completed', task1.id]);
    client.release();

    const newHealthList = await milestoneStore.getMilestoneHealth(projectId);
    assert.equal(newHealthList[0].completed_items, 1);
  });

  await t.test('7. Reject cross-project dependencies', async () => {
    const p2 = await projectStore.upsertProject({ owner: 'o2', repository: 'r2', description: 'p2' });
    const req2 = await traceabilityStore.createRequirement(p2.id, 'R2', 'D2');
    const t4 = await traceabilityStore.createWorkItem(p2.id, req2.id, 'task', 'T4', 'D4');

    await assert.rejects(
      scheduleEngine.addDependency(task1.id, t4.id),
      /Work items must belong to the same project/
    );
  });

  await t.test('8. Missing/Self dependency rejected on insert', async () => {
    await assert.rejects(
      scheduleEngine.addDependency(task1.id, task1.id),
      /Self-dependencies are not allowed/
    );
    await assert.rejects(
      scheduleEngine.addDependency(null, task1.id),
      /Missing predecessor or successor ID/
    );
  });

  await t.test('9. Invalid duration estimates rejected', async () => {
    const client = await db.getClient();
    await client.query('UPDATE pm_work_items SET estimated_duration = -5 WHERE id = $1', [task1.id]);
    client.release();

    await assert.rejects(
      scheduleEngine.calculateSchedule(projectId, false),
      /Invalid duration estimate for work item/
    );

    // Reset to valid duration for next tests
    const client2 = await db.getClient();
    await client2.query('UPDATE pm_work_items SET estimated_duration = 2 WHERE id = $1', [task1.id]);
    client2.release();
  });

  await t.test('10. Branching graph with zero-duration support', async () => {
    const p3 = await projectStore.upsertProject({ owner: 'o3', repository: 'r3', description: 'p3' });
    const req3 = await traceabilityStore.createRequirement(p3.id, 'R3', 'D3');

    const b1 = await traceabilityStore.createWorkItem(p3.id, req3.id, 'task', 'B1', 'D');
    const b2 = await traceabilityStore.createWorkItem(p3.id, req3.id, 'task', 'B2', 'D');
    const b3 = await traceabilityStore.createWorkItem(p3.id, req3.id, 'task', 'B3', 'D');
    const b4 = await traceabilityStore.createWorkItem(p3.id, req3.id, 'task', 'B4', 'D');

    const client = await db.getClient();
    await client.query('UPDATE pm_work_items SET estimated_duration = 2 WHERE id = $1', [b1.id]);
    await client.query('UPDATE pm_work_items SET estimated_duration = 3 WHERE id = $1', [b2.id]);
    await client.query('UPDATE pm_work_items SET estimated_duration = 1 WHERE id = $1', [b3.id]);
    await client.query('UPDATE pm_work_items SET estimated_duration = 0 WHERE id = $1', [b4.id]); // 0 duration
    client.release();

    // B1 -> B2 -> B4
    // B1 -> B3 -> B4
    await scheduleEngine.addDependency(b1.id, b2.id);
    await scheduleEngine.addDependency(b1.id, b3.id);
    await scheduleEngine.addDependency(b2.id, b4.id);
    await scheduleEngine.addDependency(b3.id, b4.id);

    const { scheduleItems } = await scheduleEngine.calculateSchedule(p3.id, false);
    assert.equal(scheduleItems.length, 4);

    const s1 = scheduleItems.find(i => i.work_item_id === b1.id);
    const s2 = scheduleItems.find(i => i.work_item_id === b2.id);
    const s3 = scheduleItems.find(i => i.work_item_id === b3.id);
    const s4 = scheduleItems.find(i => i.work_item_id === b4.id);

    // B1: 0-2 (critical)
    assert.equal(s1.early_start, 0);
    assert.equal(s1.early_finish, 2);
    assert.equal(s1.is_critical, true);

    // B2: 2-5 (critical)
    assert.equal(s2.early_start, 2);
    assert.equal(s2.early_finish, 5);
    assert.equal(s2.is_critical, true);

    // B3: 2-3 (slack = 2)
    assert.equal(s3.early_start, 2);
    assert.equal(s3.early_finish, 3);
    assert.equal(s3.slack, 2);
    assert.equal(s3.is_critical, false);

    // B4 (zero duration): 5-5 (critical)
    assert.equal(s4.early_start, 5);
    assert.equal(s4.early_finish, 5);
    assert.equal(s4.is_critical, true);
  });
});
