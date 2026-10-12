import { RELAY_ORIGIN, header, hasOrigin, corsHeaders } from '../../lib/assistant-access.js';
import projectStore from '../../lib/project-store.js';
import changeStore from '../../lib/change-store.js';
import { authorizeProjectAction } from '../../lib/auth.js';

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

    const project = await projectStore.getProject(owner, repository);
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    if (req.method === 'GET') {
      try {
        await authorizeProjectAction(req, project.id, 'Viewer');
        const items = await changeStore.getChangeRequests(project.id);
        return res.status(200).json({ items });
      } catch (authErr) {
        return res.status(401).json({ error: authErr.message });
      }
    }

    if (req.method === 'POST') {
      const pathParts = req.url.split('?')[0].split('/');
      const action = pathParts[pathParts.length - 1];
      const id = pathParts.length > 4 ? pathParts[4] : null;

      if (action === 'approve' && id) {
        try {
          const user = await authorizeProjectAction(req, project.id, 'Approver');
          const { notes } = req.body || {};
          const change = await changeStore.approveChangeRequest(project.id, id, user.github_username, notes);
          return res.status(200).json(change);
        } catch (authErr) {
          return res.status(401).json({ error: authErr.message });
        }
      }

      try {
        const user = await authorizeProjectAction(req, project.id, 'Manager');
        const { type, description, reason, requester, affectedFunctionality, impactScope, impactSchedule, impactDependencies, impactEffort, clientReferenceId } = req.body || {};
        const change = await changeStore.createChangeRequest(project.id, {
          type, description, reason, requester, affectedFunctionality, impactScope, impactSchedule, impactDependencies, impactEffort
        }, clientReferenceId);

        return res.status(201).json(change);
      } catch (authErr) {
        return res.status(401).json({ error: authErr.message });
      }
    }

    if (req.method === 'PUT') {
      const pathParts = req.url.split('?')[0].split('/');
      const action = pathParts[pathParts.length - 1];
      const id = pathParts.length > 4 ? pathParts[4] : null;

      if (action === 'status' && id) {
        try {
          const user = await authorizeProjectAction(req, project.id, 'Manager');
          const { status, notes } = req.body || {};
          const change = await changeStore.updateChangeRequestStatus(project.id, id, status, user.github_username, notes);
          return res.status(200).json(change);
        } catch (authErr) {
          return res.status(401).json({ error: authErr.message });
        }
      }
    }

    return res.status(405).json({ error: 'Method Not Allowed' });
  } catch (error) {
    console.error('Changes API Error:', error);
    return res.status(500).json({ error: error.message || 'Internal Server Error' });
  }
}
