import { RELAY_ORIGIN, header, hasOrigin, corsHeaders } from '../../lib/assistant-access.js';
import projectStore from '../../lib/project-store.js';
import memberStore from '../../lib/member-store.js';
import { authorizeProjectAction, authenticateRequest } from '../../lib/auth.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Vary', 'Origin');

  const origin = header(req, 'origin');
  const approvedOrigin = origin === RELAY_ORIGIN || await hasOrigin(origin);

  if (approvedOrigin) corsHeaders(res, origin);

  if (req.method === 'OPTIONS') {
    if (!approvedOrigin) return res.status(403).json({ error: 'Origin not allowed' });
    return res.status(204).send('');
  }

  if (!approvedOrigin) {
    return res.status(403).json({ error: 'Origin not allowed', code: 'EXTENSION_NOT_CONNECTED' });
  }

  try {
    const { owner, repository } = req.body || req.query || {};
    if (!owner || !repository) {
      return res.status(400).json({ error: 'Missing owner or repository' });
    }

    let project = await projectStore.getProject(owner, repository);
    if (!project) {
      project = await projectStore.upsertProject({ owner, repository, description: '' });
    }

    const pathParts = req.url.split('?')[0].split('/');
    const action = pathParts[pathParts.length - 1];

    if (req.method === 'POST' && action === 'bootstrap') {
      const user = await authenticateRequest(req);
      const member = await memberStore.bootstrapProjectAdmin(project.id, user);
      return res.status(200).json(member);
    }

    if (req.method === 'GET') {
      await authorizeProjectAction(req, project.id, 'Viewer');
      const items = await memberStore.getMembers(project.id);
      return res.status(200).json({ items });
    }

    if (req.method === 'POST') {
      const user = await authorizeProjectAction(req, project.id, 'Approver');
      const { githubId, githubUsername, role } = req.body || {};
      const member = await memberStore.addMember(project.id, githubId, githubUsername, role, user.github_username);
      return res.status(201).json(member);
    }

    if (req.method === 'PUT') {
      const user = await authorizeProjectAction(req, project.id, 'Approver');
      const targetUserId = pathParts.length > 4 ? pathParts[4] : null;
      if (action === 'role' && targetUserId) {
        const { role } = req.body || {};
        const member = await memberStore.updateMemberRole(project.id, targetUserId, role, user.github_username);
        return res.status(200).json(member);
      }
    }

    if (req.method === 'DELETE') {
      const user = await authorizeProjectAction(req, project.id, 'Approver');
      const targetUserId = action;
      if (targetUserId) {
        await memberStore.removeMember(project.id, targetUserId, user.github_username);
        return res.status(204).send('');
      }
    }

    return res.status(405).json({ error: 'Method Not Allowed' });
  } catch (error) {
    const status = error.message.includes('not a member') || error.message.includes('Action requires') || error.message.includes('Invalid or expired') || error.message.includes('Missing or invalid') ? 401 : 500;
    if (status === 500) console.error('[Members API Error]:', error);
    return res.status(status).json({ error: error.message });
  }
}
