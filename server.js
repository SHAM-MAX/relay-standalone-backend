import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import assistantRoute from './api/assistant.js';
import repositoriesRoute from './api/github/repositories.js';
import issuesRoute from './api/github/issues.js';
import pmRequirementsRoute from './api/pm/requirements.js';
import pmTraceabilityRoute from './api/pm/traceability.js';
import pmScheduleRoute from './api/pm/schedule.js';
import pmMilestonesRoute from './api/pm/milestones.js';
import pmRisksRoute from './api/pm/risks.js';
import pmChangesRoute from './api/pm/changes.js';
import pmMembersRoute from './api/pm/members.js';
import pmAssignmentRoute from './api/pm/assignment.js';
import pmHealthRoute from './api/pm/health.js';
import pmReportsRoute from './api/pm/reports.js';
import authRoute from './api/auth.js';
import db from './lib/db.js';
import { getMigrationStatus } from './lib/migrator.js';

dotenv.config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Wrap express (req, res) for compatibility with our module structure
const wrap = (handler) => async (req, res) => {
  try {
    await handler(req, res);
  } catch (error) {
    console.error(error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal server error' });
    }
  }
};

app.post('/api/assistant', wrap(assistantRoute));
app.options('/api/assistant', wrap(assistantRoute));

app.use('/api/auth', authRoute);

app.get('/api/github/repositories', wrap(repositoriesRoute));
app.options('/api/github/repositories', wrap(repositoriesRoute));

app.post('/api/github/issues', wrap(issuesRoute));
app.options('/api/github/issues', wrap(issuesRoute));

app.get('/api/pm/requirements', wrap(pmRequirementsRoute));
app.options('/api/pm/requirements', wrap(pmRequirementsRoute));

app.get('/api/pm/traceability', wrap(pmTraceabilityRoute));
app.options('/api/pm/traceability', wrap(pmTraceabilityRoute));

app.post('/api/pm/schedule', wrap(pmScheduleRoute));
app.get('/api/pm/schedule', wrap(pmScheduleRoute));
app.options('/api/pm/schedule', wrap(pmScheduleRoute));

app.get('/api/pm/milestones', wrap(pmMilestonesRoute));
app.options('/api/pm/milestones', wrap(pmMilestonesRoute));

app.use('/api/pm/risks', wrap(pmRisksRoute));
app.options('/api/pm/risks', wrap(pmRisksRoute));
app.options('/api/pm/risks/*', wrap(pmRisksRoute));

// Changes routing logic requires supporting PUT and path params, which we handle simply inside changes.js, but need to register paths.
app.use('/api/pm/changes', wrap(pmChangesRoute));
app.options('/api/pm/changes', wrap(pmChangesRoute));
app.options('/api/pm/changes/*', wrap(pmChangesRoute));

app.use('/api/pm/members', wrap(pmMembersRoute));
app.options('/api/pm/members', wrap(pmMembersRoute));
app.options('/api/pm/members/*', wrap(pmMembersRoute));

app.use('/api/pm/assignment', pmAssignmentRoute);
app.use('/api/pm/health', pmHealthRoute);
app.use('/api/pm/reports', pmReportsRoute);

// Health check endpoint preserving exact contract: { status: 'ok' }
app.get('/health', async (req, res) => {
  const dbHealth = await db.healthCheck();
  res.json({
    status: 'ok',
    database: dbHealth.ok ? 'connected' : 'unavailable'
  });
});

const server = app.listen(PORT, '0.0.0.0', async () => {
  console.log(`Relay standalone backend listening on port ${PORT}`);

  // Inspect database connection and migration status on startup
  try {
    const health = await db.healthCheck();
    if (health.ok) {
      console.log(`[Database]: Connection verified (${health.type}, latency: ${health.latencyMs}ms)`);
      const status = await getMigrationStatus().catch(() => []);
      const pending = status.filter((m) => !m.applied);
      if (pending.length > 0) {
        console.log(`[Database Notice]: ${pending.length} pending migration(s) detected. Run 'npm run migrate' to apply.`);
      } else {
        console.log(`[Database]: Schema migrations up-to-date (${status.length} verified).`);
      }
    } else {
      console.warn(`[Database Warning]: Health check returned unavailable: ${health.error}`);
    }
  } catch (err) {
    console.warn('[Database Notice]: Initial connection check deferred:', err.message);
  }
});

// Clean shutdown
const shutdown = async () => {
  console.log('Shutting down server gracefully...');
  server.close(async () => {
    await db.closePool().catch(() => {});
    process.exit(0);
  });
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

export default app;
