import { gateAssistant } from '../lib/assistant-access.js';
import { validateAssistantRequest, answerAssistant, assistantError } from '../lib/assistant.js';

// Public dispatch is required for credential-free CORS OPTIONS. gateAssistant
// explicitly requires platform-resolved req.member for every POST before AI runs.
// The existing member-gated /analyze, /github, and /workspace are unchanged.
export const access = 'public';
export const methods = ['POST', 'OPTIONS'];
export default async function (req, res) {
  try {
    if (!await gateAssistant(req, res)) return;
    const input = validateAssistantRequest(req.body);
    // Since we are standalone, we'll just use a default memberId for history or read it if passed.
    // The previous implementation used req.member.id which came from the hatchable session.
    // We will use a fixed ID to preserve single-user session history behavior.
    const memberId = 'standalone-user';
    const response = await answerAssistant(input, memberId);
    return res.json(response);
  } catch (error) {
    const safe = assistantError(error);
    return res.status(safe.status).json(safe.body);
  }
}
