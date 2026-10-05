import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import assistantRoute from './api/assistant.js';
import repositoriesRoute from './api/github/repositories.js';

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

app.post('/api/github/repositories', wrap(repositoriesRoute));
app.options('/api/github/repositories', wrap(repositoriesRoute));

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Relay standalone backend listening on port ${PORT}`);
});
