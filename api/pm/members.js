import { corsHeaders, validateOrigin } from '../../lib/cors.js';
import projectStore from '../../lib/project-store.js';
import memberStore from '../../lib/member-store.js';
import { authorizeProjectAction, authenticateRequest } from '../../lib/auth.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders);
    res.end();
    return;
  }

  try {
    const originValid = await validateOrigin(req, res);
    if (!originValid) return;

    const { owner, repository } = req.body || {};
    if (!owner || !repository) {
      res.writeHead(400, { 'Content-Type': 'application/json', ...corsHeaders });
      res.end(JSON.stringify({ error: 'Missing owner or repository' }));
      return;
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
      res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
      res.end(JSON.stringify(member));
      return;
    }

    if (req.method === 'GET') {
      await authorizeProjectAction(req, project.id, 'Viewer');
      const items = await memberStore.getMembers(project.id);
      res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
      res.end(JSON.stringify({ items }));
      return;
    }

    if (req.method === 'POST') {
      const user = await authorizeProjectAction(req, project.id, 'Approver');
      const { githubId, githubUsername, role } = req.body;
      const member = await memberStore.addMember(project.id, githubId, githubUsername, role, user.github_username);
      res.writeHead(201, { 'Content-Type': 'application/json', ...corsHeaders });
      res.end(JSON.stringify(member));
      return;
    }

    if (req.method === 'PUT') {
      const user = await authorizeProjectAction(req, project.id, 'Approver');
      const targetUserId = pathParts.length > 4 ? pathParts[4] : null;
      if (action === 'role' && targetUserId) {
        const { role } = req.body;
        const member = await memberStore.updateMemberRole(project.id, targetUserId, role, user.github_username);
        res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify(member));
        return;
      }
    }

    if (req.method === 'DELETE') {
      const user = await authorizeProjectAction(req, project.id, 'Approver');
      const targetUserId = action;
      if (targetUserId) {
        await memberStore.removeMember(project.id, targetUserId, user.github_username);
        res.writeHead(204, corsHeaders);
        res.end();
        return;
      }
    }

    res.writeHead(405, corsHeaders);
    res.end(JSON.stringify({ error: 'Method Not Allowed' }));
  } catch (error) {
    const status = error.message.includes('not a member') || error.message.includes('Action requires') || error.message.includes('Invalid or expired') || error.message.includes('Missing or invalid') ? 401 : 500;
    if (status === 500) console.error('[Members API Error]:', error);
    res.writeHead(status, { 'Content-Type': 'application/json', ...corsHeaders });
    res.end(JSON.stringify({ error: error.message }));
  }
}
