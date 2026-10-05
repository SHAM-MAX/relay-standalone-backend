import { db } from 'hatchable';
import { RELAY_ORIGIN, header, extensionOrigin, hasOrigin, isJSON } from 'lib/assistant-access.js';
export const access = 'member';
export const methods = ['GET', 'POST'];
export default async function (req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const extensionId = req.method === 'GET' ? req.query?.extension_id : req.body?.extensionId;
    const origin = extensionOrigin(extensionId);
    if (!origin) return res.status(400).json({ error: 'Open this page using Connect Relay in the installed extension.', code: 'INVALID_EXTENSION_ID' });
    const memberId = String(req.member.id);
    if (req.method === 'GET') return res.json({ connected: await hasOrigin(db, origin, memberId), extensionId });
    // Only the authenticated Relay-origin connect page can change the allowlist.
    // The extension and all other sites cannot self-register using a cross-origin POST.
    if (header(req, 'origin') !== RELAY_ORIGIN || !isJSON(req)) return res.status(403).json({ error: 'Connect from the Relay connection page.', code: 'ORIGIN_NOT_ALLOWED' });
    if (req.body.action === 'connect') {
      await db.query('INSERT INTO relay_extension_origins (member_id, origin) VALUES ($1,$2) ON CONFLICT (member_id,origin) DO UPDATE SET updated_at = now()', [memberId, origin]);
      return res.json({ connected: true, extensionId });
    }
    if (req.body.action === 'disconnect') {
      await db.query('DELETE FROM relay_extension_origins WHERE member_id = $1 AND origin = $2', [memberId, origin]);
      return res.json({ connected: false, extensionId });
    }
    return res.status(400).json({ error: 'Choose connect or disconnect.', code: 'INVALID_ACTION' });
  } catch { return res.status(503).json({ error: 'The extension connection could not be saved. Please retry.', code: 'CONNECTION_UNAVAILABLE' }); }
}
