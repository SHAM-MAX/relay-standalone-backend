import test from 'node:test';
import assert from 'node:assert';
import db from '../lib/db.js';
import { runMigrations } from '../lib/migrator.js';
import projectStore from '../lib/project-store.js';
import memberStore from '../lib/member-store.js';
import { setProjectRole, upsertUser } from '../lib/auth.js';

test('Phase 4.5 Step 2: Member Management', async (t) => {
  await runMigrations();

  let projectId;
  let adminUserId;

  process.env.ADMIN_GITHUB_IDS = 'gh-admin,gh-other';

  await t.test('1. Bootstrap Project Admin', async () => {
    const project = await projectStore.upsertProject({
      owner: 'auth-owner',
      repository: 'member-repo',
      description: 'Phase 4.5 step 2 test'
    });
    projectId = project.id;

    const user = await upsertUser('gh-admin', 'admin-user');
    adminUserId = user.id;

    // Bootstrap first admin
    const member = await memberStore.bootstrapProjectAdmin(projectId, user);
    assert.equal(member.role, 'Approver');

    // Attempt to bootstrap again should fail
    const user2 = await upsertUser('gh-other', 'other-user');
    await assert.rejects(
      memberStore.bootstrapProjectAdmin(projectId, user2),
      /Project already has an Approver/
    );
  });

  await t.test('2. Add Members and Duplicate Rejection', async () => {
    const member = await memberStore.addMember(projectId, 'gh-dev1', 'dev-user', 'Viewer', 'admin-user');
    assert.equal(member.role, 'Viewer');

    // Duplicate rejection
    await assert.rejects(
      memberStore.addMember(projectId, 'gh-dev1', 'dev-user', 'Manager', 'admin-user'),
      /User is already a member/
    );

    // Invalid role
    await assert.rejects(
      memberStore.addMember(projectId, 'gh-dev2', 'dev2-user', 'Owner', 'admin-user'),
      /Invalid role/
    );
  });

  await t.test('3. Role Modification', async () => {
    const members = await memberStore.getMembers(projectId);
    const devUser = members.find(m => m.github_username === 'dev-user');

    // Change to Manager
    const updated = await memberStore.updateMemberRole(projectId, devUser.user_id, 'Manager', 'admin-user');
    assert.equal(updated.role, 'Manager');

    // Audit History Consistency
    const history = await db.query(`SELECT * FROM pm_membership_history WHERE project_id = $1 ORDER BY created_at ASC`, [projectId]);

    // Bootstrap (added) -> addMember (added) -> updateRole (role_changed)
    assert.ok(history.rows.length >= 3);
    const lastEvent = history.rows[history.rows.length - 1];
    assert.equal(lastEvent.action, 'role_changed');
    assert.equal(lastEvent.old_role, 'Viewer');
    assert.equal(lastEvent.new_role, 'Manager');
    assert.equal(lastEvent.changed_by, 'admin-user');
  });

  await t.test('4. Remove Member', async () => {
    const members = await memberStore.getMembers(projectId);
    const devUser = members.find(m => m.github_username === 'dev-user');

    await memberStore.removeMember(projectId, devUser.user_id, 'admin-user');

    const remaining = await memberStore.getMembers(projectId);
    assert.ok(!remaining.find(m => m.github_username === 'dev-user'));

    // Verify history
    const history = await db.query(`SELECT action FROM pm_membership_history WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`, [devUser.user_id]);
    assert.equal(history.rows[0].action, 'removed');
  });

  await t.test('5. Cross-Project Access', async () => {
    const p2 = await projectStore.upsertProject({
      owner: 'other-owner', repository: 'other-repo'
    });

    const user = await upsertUser('gh-dev3', 'dev3-user');
    await setProjectRole(p2.id, user.id, 'Viewer');

    // Try to modify role in another project where member doesn't exist
    await assert.rejects(
      memberStore.updateMemberRole(projectId, user.id, 'Manager', 'admin-user'),
      /Member not found in this project/
    );
  });

  await t.test('6. Cleanup', async () => {
    await db.closePool().catch(() => {});
  });
});
