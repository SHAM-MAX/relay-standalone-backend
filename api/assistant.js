import { gateAssistant } from '../lib/assistant-access.js';
import { validateAssistantRequest, answerAssistant, assistantError } from '../lib/assistant.js';
import { authenticateRequest, decryptToken } from '../lib/auth.js';

// Public dispatch is required for credential-free CORS OPTIONS. gateAssistant
// explicitly requires platform-resolved req.member for every POST before AI runs.
// The existing member-gated /analyze, /github, and /workspace are unchanged.
export const access = 'public';
export const methods = ['POST', 'OPTIONS'];
export default async function (req, res) {
  try {
    if (!await gateAssistant(req, res)) return;
    const input = validateAssistantRequest(req.body);

    let user;
    try {
      user = await authenticateRequest(req);
    } catch (e) {
      return res.status(401).json({ error: 'Authentication failed.', code: 'UNAUTHORIZED' });
    }

    if (!user || !user.encrypted_token || !user.token_iv) {
      return res.status(401).json({ error: 'Missing GitHub token. Reconnect your account.', code: 'MISSING_GITHUB_TOKEN' });
    }

    const token = decryptToken(user.encrypted_token, user.token_iv);
    if (!token) {
      return res.status(401).json({ error: 'Invalid GitHub token. Reconnect your account.', code: 'INVALID_GITHUB_TOKEN' });
    }

    const memberId = user.id;
    const response = await answerAssistant(input, memberId, token);
    return res.json(response);
  } catch (error) {
    const safe = assistantError(error);
    return res.status(safe.status).json(safe.body);
  }
}
