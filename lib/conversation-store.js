import db from './db.js';

/**
 * Normalizes memberId to a safe string identifier.
 */
function normalizeMemberId(memberId) {
  if (memberId === null || memberId === undefined) {
    return 'default-member';
  }
  return String(memberId).trim() || 'default-member';
}

/**
 * Finds or creates a conversation record for a member (optionally scoped to a project).
 */
export async function getOrCreateConversation(memberId, projectId = null) {
  const normMemberId = normalizeMemberId(memberId);

  try {
    const existing = await db.query(
      `SELECT * FROM pm_conversations
       WHERE member_id = $1 AND (project_id = $2 OR ($2 IS NULL AND project_id IS NULL))
       ORDER BY updated_at DESC
       LIMIT 1;`,
      [normMemberId, projectId]
    );

    if (existing.rows.length > 0) {
      return existing.rows[0];
    }

    const created = await db.query(
      `INSERT INTO pm_conversations (member_id, project_id)
       VALUES ($1, $2)
       RETURNING *;`,
      [normMemberId, projectId]
    );

    return created.rows[0];
  } catch (error) {
    console.error('[ConversationStore Error]: Failed getOrCreateConversation:', {
      memberId: normMemberId,
      projectId,
      error: error.message
    });
    throw Object.assign(new Error(`Failed to resolve conversation session: ${error.message}`), {
      status: 500,
      code: 'CONVERSATION_PERSISTENCE_FAILED',
      cause: error
    });
  }
}

/**
 * Retrieves the recent message history for a member/project, formatted for LLM prompts.
 * Exactly preserves the { role, content } shape and maximum message count (default 10).
 */
export async function getConversationHistory(memberId, projectId = null, limit = 10) {
  const normMemberId = normalizeMemberId(memberId);

  try {
    const conv = await getOrCreateConversation(normMemberId, projectId);

    const result = await db.query(
      `SELECT role, content
       FROM (
         SELECT id, role, content
         FROM pm_conversation_messages
         WHERE conversation_id = $1
         ORDER BY id DESC
         LIMIT $2
       ) sub
       ORDER BY id ASC;`,
      [conv.id, limit]
    );

    return result.rows.map((row) => ({
      role: row.role,
      content: row.content
    }));
  } catch (error) {
    console.error('[ConversationStore Error]: Failed getConversationHistory:', {
      memberId: normMemberId,
      projectId,
      error: error.message
    });
    throw Object.assign(new Error(`Failed to retrieve conversation history: ${error.message}`), {
      status: 500,
      code: 'CONVERSATION_RETRIEVAL_FAILED',
      cause: error
    });
  }
}

/**
 * Persists a complete conversation turn (user prompt + assistant response).
 * Transactional and handles failures cleanly without silent loss.
 */
export async function appendConversationTurn(memberId, projectId = null, { userMessage, assistantReply, model = null }) {
  const normMemberId = normalizeMemberId(memberId);

  if (typeof userMessage !== 'string' || !userMessage.trim()) {
    throw Object.assign(new Error('User message is required to persist conversation turn.'), { status: 400, code: 'INVALID_MESSAGE' });
  }
  if (typeof assistantReply !== 'string' || !assistantReply.trim()) {
    throw Object.assign(new Error('Assistant reply is required to persist conversation turn.'), { status: 400, code: 'INVALID_REPLY' });
  }

  let client;
  try {
    client = await db.getClient();
  } catch (error) {
    console.error('[ConversationStore Error]: Failed to acquire client:', error.message);
    throw Object.assign(new Error(`Failed to persist conversation turn: ${error.message}`), {
      status: 500,
      code: 'CONVERSATION_PERSISTENCE_FAILED',
      cause: error
    });
  }

  try {
    await client.query('BEGIN');

    // Find or create conversation within transaction
    let convId;
    const existing = await client.query(
      `SELECT id FROM pm_conversations
       WHERE member_id = $1 AND (project_id = $2 OR ($2 IS NULL AND project_id IS NULL))
       ORDER BY updated_at DESC
       LIMIT 1;`,
      [normMemberId, projectId]
    );

    if (existing.rows.length > 0) {
      convId = existing.rows[0].id;
    } else {
      const created = await client.query(
        `INSERT INTO pm_conversations (member_id, project_id)
         VALUES ($1, $2)
         RETURNING id;`,
        [normMemberId, projectId]
      );
      convId = created.rows[0].id;
    }

    // Insert user message
    await client.query(
      `INSERT INTO pm_conversation_messages (conversation_id, role, content, model)
       VALUES ($1, 'user', $2, $3);`,
      [convId, userMessage.trim(), model]
    );

    // Insert assistant reply
    await client.query(
      `INSERT INTO pm_conversation_messages (conversation_id, role, content, model)
       VALUES ($1, 'assistant', $2, $3);`,
      [convId, assistantReply.trim(), model]
    );

    // Update conversation timestamp
    await client.query(
      `UPDATE pm_conversations SET updated_at = now() WHERE id = $1;`,
      [convId]
    );

    await client.query('COMMIT');
    return { success: true, conversationId: convId };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[ConversationStore Error]: Failed appendConversationTurn:', {
      memberId: normMemberId,
      projectId,
      error: error.message
    });
    throw Object.assign(new Error(`Failed to persist conversation turn: ${error.message}`), {
      status: 500,
      code: 'CONVERSATION_PERSISTENCE_FAILED',
      cause: error
    });
  } finally {
    client.release();
  }
}

/**
 * Clears conversation history for a given member/project.
 */
export async function clearConversationHistory(memberId, projectId = null) {
  const normMemberId = normalizeMemberId(memberId);
  try {
    const conv = await db.query(
      `SELECT id FROM pm_conversations
       WHERE member_id = $1 AND (project_id = $2 OR ($2 IS NULL AND project_id IS NULL))
       LIMIT 1;`,
      [normMemberId, projectId]
    );

    if (conv.rows.length > 0) {
      await db.query('DELETE FROM pm_conversation_messages WHERE conversation_id = $1;', [conv.rows[0].id]);
      await db.query('UPDATE pm_conversations SET updated_at = now() WHERE id = $1;', [conv.rows[0].id]);
    }
    return { success: true };
  } catch (error) {
    console.error('[ConversationStore Error]: Failed clearConversationHistory:', { memberId: normMemberId, error: error.message });
    throw Object.assign(new Error(`Failed to clear conversation history: ${error.message}`), {
      status: 500,
      code: 'CONVERSATION_CLEAR_FAILED',
      cause: error
    });
  }
}

export default {
  getOrCreateConversation,
  getConversationHistory,
  appendConversationTurn,
  clearConversationHistory
};
