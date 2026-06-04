import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import { config } from './config.js';
import { router } from './routes/index.js';
import { startAlertWorker } from './services/alerts/worker.js';

const app = express();

app.use(cors({ origin: config.corsOrigin }));
app.use(express.json());
if (config.nodeEnv !== 'test') app.use(morgan('dev'));

app.use('/api', router);

app.get('/', (_req, res) => {
  res.json({ name: 'public-risk-radar API', see: '/api/health' });
});

app.use((req, res) => {
  res.status(404).json({ error: `not found: ${req.method} ${req.path}` });
});

app.listen(config.port, () => {
  console.log(`[prr] API listening on http://localhost:${config.port}`);
  if (!config.airnowApiKey) {
    console.warn('[prr] AIRNOW_API_KEY not set — air quality will return empty.');
  }
  if (config.alertsEnabled) {
    startAlertWorker();
    console.log(`[prr] alert worker started (every ${config.alertsIntervalMs}ms).`);
  }
});
