import { corsHeaders, validateOrigin } from '../../lib/cors.js';
import projectStore from '../../lib/project-store.js';
import riskStore from '../../lib/risk-store.js';
import { authorizeProjectAction } from '../../lib/auth.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders);
    res.end();
    return;
  }

  if (!validateOrigin(req)) {
    res.writeHead(403, corsHeaders);
    res.end(JSON.stringify({ error: 'Forbidden' }));
    return;
  }

  try {
    const { owner, repository } = req.body || req.query;
    if (!owner || !repository) {
      res.writeHead(400, corsHeaders);
      res.end(JSON.stringify({ error: 'Missing owner or repository' }));
      return;
    }

    const project = await projectStore.getProject(owner, repository);
    if (!project) {
      res.writeHead(404, corsHeaders);
      res.end(JSON.stringify({ error: 'Project not found' }));
      return;
    }

    if (req.method === 'GET') {
      try {
        await authorizeProjectAction(req, project.id, 'Viewer');
        const summary = await riskStore.getProjectRiskSummary(project.id);
        const items = await riskStore.getRisks(project.id);
        res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify({ summary, items }));
      } catch (authErr) {
        res.writeHead(401, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify({ error: authErr.message }));
      }
      return;
    }

    if (req.method === 'POST') {
      try {
        const user = await authorizeProjectAction(req, project.id, 'Manager');
        const { title, probability, impact, description, category, mitigationStrategy, response, workItemId, milestoneId, clientReferenceId } = req.body;
        const risk = await riskStore.createRisk(project.id, {
          title, probability, impact, description, category, mitigationStrategy, response, owner: user.github_username, workItemId, milestoneId
        }, clientReferenceId);

        res.writeHead(201, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify(risk));
      } catch (authErr) {
        res.writeHead(401, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify({ error: authErr.message }));
      }
      return;
    }

    if (req.method === 'PUT') {
      const pathParts = req.url.split('?')[0].split('/');
      const action = pathParts[pathParts.length - 1];
      const id = pathParts.length > 4 ? pathParts[4] : null;

      if (action === 'status' && id) {
        try {
          const user = await authorizeProjectAction(req, project.id, 'Manager');
          const { status } = req.body;
          const risk = await riskStore.updateRiskStatus(project.id, id, status, user.github_username);
          res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
          res.end(JSON.stringify(risk));
        } catch (authErr) {
          res.writeHead(401, { 'Content-Type': 'application/json', ...corsHeaders });
          res.end(JSON.stringify({ error: authErr.message }));
        }
        return;
      }
    }

    res.writeHead(405, corsHeaders);
    res.end(JSON.stringify({ error: 'Method Not Allowed' }));
  } catch (error) {
    console.error('Risks API Error:', error);
    res.writeHead(500, corsHeaders);
    res.end(JSON.stringify({ error: error.message || 'Internal Server Error' }));
  }
}
