import test from 'node:test';
import assert from 'node:assert';
import db from '../lib/db.js';
import { runMigrations } from '../lib/migrator.js';
import { createOAuthState, consumeOAuthState, createSession, revokeSession, getSessionUser } from '../lib/session.js';
import { upsertUser, setProjectRole } from '../lib/auth.js';
import projectStore from '../lib/project-store.js';

test('OAuth and Sessions', async (t) => {
  await runMigrations();

  let state;
  let user;
  let sessionId;

  await t.test('1. OAuth State Generation and Single Use', async () => {
    state = await createOAuthState();
    assert.ok(state.length > 10, 'State should be a secure random string');

    // Consume state once successfully
    await consumeOAuthState(state);

    // Consume state again should fail
    await assert.rejects(
      consumeOAuthState(state),
      /Invalid or expired state/
    );
  });

  await t.test('2. Opaque Sessions', async () => {
    user = await upsertUser('oauth-gh-123', 'oauth-user');
    sessionId = await createSession(user.id);

    assert.ok(sessionId.length > 10, 'Session ID should be random');

    // Retrieve user via session
    const sessionUser = await getSessionUser(sessionId);
    assert.equal(sessionUser.id, user.id);
    assert.equal(sessionUser.github_username, 'oauth-user');
  });

  await t.test('3. Session Revocation', async () => {
    await revokeSession(sessionId);

    // Retrieve should fail now
    await assert.rejects(
      getSessionUser(sessionId),
      /Invalid or expired session/
    );
  });

  await t.test('4. RBAC via Session (Integration)', async () => {
    const project = await projectStore.upsertProject({
      owner: 'oauth-owner',
      repository: 'oauth-repo',
      description: 'OAuth testing'
    });

    const newUser = await upsertUser('oauth-gh-999', 'another-user');
    const newSession = await createSession(newUser.id);
    await setProjectRole(project.id, newUser.id, 'Approver');

    // We can't easily mock req.headers.cookie for the full authorizeProjectAction flow
    // inside this unit test without setting up Express supertest, but the session logic holds.
    // The previous test suite (auth.test.js) verifies authenticateRequest with the session logic if we mock req.
    const reqMock = { headers: { cookie: `relay_pm_session=${newSession}` } };

    const { authenticateRequest, authorizeProjectAction } = await import('../lib/auth.js');
    const authUser = await authenticateRequest(reqMock);
    assert.equal(authUser.id, newUser.id);

    const authorized = await authorizeProjectAction(reqMock, project.id, 'Manager');
    assert.equal(authorized.id, newUser.id);
  });

  await t.test('Cleanup', async () => {
    await db.closePool().catch(() => {});
  });
});
