import crypto from 'crypto';
import db from './db.js';

export async function createOAuthState() {
  const state = crypto.randomBytes(32).toString('hex');
  // Expires in 10 minutes
  await db.query(
    `INSERT INTO pm_oauth_states (state, expires_at) VALUES ($1, now() + interval '10 minutes')`,
    [state]
  );
  return state;
}

export async function consumeOAuthState(state) {
  const res = await db.query(
    `DELETE FROM pm_oauth_states WHERE state = $1 AND expires_at > now() RETURNING *`,
    [state]
  );
  if (res.rows.length === 0) {
    throw new Error('Invalid or expired state');
  }
}

export async function createSession(userId) {
  const sessionId = crypto.randomBytes(64).toString('hex');
  const hashedId = crypto.createHash('sha256').update(sessionId).digest('hex');
  // Expires in 24 hours
  await db.query(
    `INSERT INTO pm_sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '24 hours')`,
    [hashedId, userId]
  );
  return sessionId;
}

export async function revokeSession(sessionId) {
  const hashedId = crypto.createHash('sha256').update(sessionId).digest('hex');
  await db.query(
    `UPDATE pm_sessions SET revoked_at = now() WHERE id = $1`,
    [hashedId]
  );
}

export async function getSessionUser(sessionId) {
  const hashedId = crypto.createHash('sha256').update(sessionId).digest('hex');
  const res = await db.query(
    `SELECT u.*
     FROM pm_sessions s
     JOIN pm_users u ON s.user_id = u.id
     WHERE s.id = $1
       AND s.expires_at > now()
       AND s.revoked_at IS NULL`,
    [hashedId]
  );
  if (res.rows.length === 0) {
    throw new Error('Invalid or expired session');
  }
  return res.rows[0];
}
