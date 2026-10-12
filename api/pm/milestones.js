import { RELAY_ORIGIN, header, hasOrigin, corsHeaders, isJSON } from '../../lib/assistant-access.js';
import projectStore from '../../lib/project-store.js';
import milestoneStore from '../../lib/milestone-store.js';

export default async function (req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Vary', 'Origin');

  const origin = header(req, 'origin');
  const approvedOrigin = origin === RELAY_ORIGIN || await hasOrigin(origin);

  if (approvedOrigin) corsHeaders(res, origin);

  if (req.method === 'OPTIONS') return res.status(204).send('');
  if (!approvedOrigin) return res.status(403).json({ error: 'Origin not allowed', code: 'EXTENSION_NOT_CONNECTED' });

  const { owner, repo } = req.query;
  if (!owner || !repo) return res.status(400).json({ error: 'Missing owner or repo', code: 'INVALID_REQUEST' });

  try {
    const project = await projectStore.getProject(owner, repo);
    if (!project) return res.status(404).json({ error: 'Project not found', code: 'PROJECT_NOT_FOUND' });

    if (req.method === 'GET') {
      const health = await milestoneStore.getMilestoneHealth(project.id);
      return res.json({ milestones: health });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    return res.status(500).json({ error: error.message, code: 'INTERNAL_ERROR' });
  }
}
