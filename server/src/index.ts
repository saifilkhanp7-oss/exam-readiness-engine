import express from 'express';
import cors from 'cors';
import fs from 'node:fs';
import path from 'node:path';
import { PORT, CLIENT_DIST, APP_NAME } from './config.ts';
import './db.ts';
import { authRouter } from './auth.ts';
import { api } from './api.ts';
import { emailMode } from './mailer.ts';
import { aiEnabled, aiName } from './ai.ts';
import { startWorker } from './jobs.ts';

const app = express();
app.set('trust proxy', 1);
app.use(cors());
app.use(express.json({ limit: '2mb' }));

app.get('/api/health', (_req, res) => { res.json({ ok: true, app: APP_NAME, email: emailMode(), ai: aiEnabled() ? aiName() : false }); });
app.use('/api/auth', authRouter);
app.use('/api', api);

if (fs.existsSync(CLIENT_DIST)) {
  app.use(express.static(CLIENT_DIST));
  app.get(/^\/(?!api).*/, (_req, res) => res.sendFile(path.join(CLIENT_DIST, 'index.html')));
}

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  res.status(500).json({ error: err.message || 'Something went wrong' });
});

startWorker();
app.listen(PORT, () => {
  console.log(`${APP_NAME} API on http://localhost:${PORT} · email: ${emailMode()} · AI: ${aiEnabled() ? aiName() : 'offline fallback'}`);
  if (emailMode() === 'none') console.log(process.env.OTP_DEMO_MODE === 'true'
    ? 'OTP demo mode: codes are shown on screen.'
    : 'No email settings: login codes are printed here (and shown on screen when not in production).');
});
