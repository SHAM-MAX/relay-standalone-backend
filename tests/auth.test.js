import test from 'node:test';
import assert from 'node:assert';
import db from '../lib/db.js';
import { runMigrations } from '../lib/migrator.js';
import projectStore from '../lib/project-store.js';
import { authenticateRequest, getProjectRole, setProjectRole, authorizeProjectAction, upsertUser, decryptToken } from '../lib/auth.js';
import { createSession } from '../lib/session.js';
import crypto from 'crypto';

test('Phase 4.5: Authentication and RBAC', async (t) => {
  await runMigrations();

  let projectId;
  let user1;
  let user2;

  await t.test('1. Setup project and users', async () => {
    const project = await projectStore.upsertProject({
      owner: 'auth-owner',
      repository: 'auth-repo',
      description: 'Phase 4.5 test'
    });
    projectId = project.id;

    // Use internal function to create test users
    user1 = await upsertUser('gh-111', 'viewer-user');
    user2 = await upsertUser('gh-222', 'approver-user');

    await setProjectRole(projectId, user1.id, 'Viewer');
    await setProjectRole(projectId, user2.id, 'Approver');
  });

  await t.test('2. Token authentication', async () => {
    // Missing header/cookie
    await assert.rejects(
      authenticateRequest({ headers: {} }),
      /Missing session cookie/
    );

    // Invalid session cookie
    await assert.rejects(
      authenticateRequest({ headers: { cookie: 'relay_pm_session=invalid-session-123' } }),
      /Invalid or expired session/
    );

    // Valid mock session
    const sessionId = await createSession(user1.id);
    const user = await authenticateRequest({ headers: { cookie: `relay_pm_session=${sessionId}` } });
    assert.equal(user.github_username, 'viewer-user');

    // Regression test for hardcoded bypass removal
    await assert.rejects(
      authenticateRequest({ headers: { authorization: 'Bearer test-valid-token' } }),
      /Missing session cookie/
    );
  });

  await t.test('3. Role enforcement', async () => {
    // Let's create a session for user1 (Viewer)
    const viewerSessionId = await createSession(user1.id);
    const reqViewer = { headers: { cookie: `relay_pm_session=${viewerSessionId}` } };

    // Let's create a session for user2 (Approver)
    const approverSessionId = await createSession(user2.id);
    const reqApprover = { headers: { cookie: `relay_pm_session=${approverSessionId}` } };

    // Test Viewer trying to do Manager action
    await assert.rejects(
      authorizeProjectAction(reqViewer, projectId, 'Manager'),
      /Action requires Manager role, but user is Viewer/
    );

    // Test Viewer trying to do Viewer action
    const authorizedViewer = await authorizeProjectAction(reqViewer, projectId, 'Viewer');
    assert.equal(authorizedViewer.id, user1.id);

    // Test Approver trying to do Approver action
    const authorizedApprover = await authorizeProjectAction(reqApprover, projectId, 'Approver');
    assert.equal(authorizedApprover.id, user2.id);

    // Test Cross-Project Access (User not in project)
    const p2 = await projectStore.upsertProject({
      owner: 'other', repository: 'other'
    });

    await assert.rejects(
      authorizeProjectAction(reqViewer, p2.id, 'Viewer'),
      /User is not a member of this project/
    );

    // Test unknown required role
    await assert.rejects(
      authorizeProjectAction(reqApprover, projectId, 'SuperAdmin'),
      /Unknown required role: SuperAdmin/
    );
  });

  await t.test('4. Token decryption safety', async () => {
    const validKey = '0000000000000000000000000000000000000000000000000000000000000000'; // 32 bytes hex
    const originalKey = process.env.TOKEN_ENCRYPTION_KEY;

    try {
      process.env.TOKEN_ENCRYPTION_KEY = validKey;
      const iv = crypto.randomBytes(12).toString('hex');
      const keyBuf = Buffer.from(validKey, 'hex');
      const cipher = crypto.createCipheriv('aes-256-gcm', keyBuf, Buffer.from(iv, 'hex'));
      let enc = cipher.update('my-secret-token', 'utf8', 'hex');
      enc += cipher.final('hex');
      const tag = cipher.getAuthTag().toString('hex');
      const validTokenString = `${enc}:${tag}`;

      // Valid case
      assert.equal(decryptToken(validTokenString, iv), 'my-secret-token');

      // Invalid IV
      const badIv = crypto.randomBytes(12).toString('hex');
      assert.equal(decryptToken(validTokenString, badIv), null);

      // Malformed ciphertext (tampered tag)
      const tamperedTag = (tag[0] === '0' ? '1' : '0') + tag.slice(1);
      assert.equal(decryptToken(`${enc}:${tamperedTag}`, iv), null);

      // Malformed structure
      assert.equal(decryptToken('invalid-structure', iv), null);

      // Missing env var
      delete process.env.TOKEN_ENCRYPTION_KEY;
      assert.equal(decryptToken(validTokenString, iv), null);
    } finally {
      if (originalKey === undefined) {
        delete process.env.TOKEN_ENCRYPTION_KEY;
      } else {
        process.env.TOKEN_ENCRYPTION_KEY = originalKey;
      }
    }
  });

  await t.test('5. Cleanup', async () => {
    await db.closePool().catch(() => {});
  });
});
