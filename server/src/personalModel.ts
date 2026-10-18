// Fits the memory model to one student once they have enough answers, then replays their history with it.
import db from './db.ts';
import {
  DEFAULT_PARAMS, MIN_ANSWERS_TO_FIT, fitUserParams, replayTopic, hourBucket, type FitTopic, type PersonalParams,
} from '@ere/engine';
import { saveTopicState } from './store.ts';

const REFIT_EVERY = 50;          // new answers
const REFIT_AFTER = 7 * 86400000; // or a week

const hourIn = (ts: number, tz: string) => Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hourCycle: 'h23' }).format(ts));

function medianResponse(userId: number) {
  const xs = (db.prepare('SELECT response_ms FROM attempts WHERE user_id=? ORDER BY id DESC LIMIT 300').all(userId) as { response_ms: number }[]).map(r => r.response_ms).sort((a, b) => a - b);
  return xs[xs.length >> 1] || 10000;
}

/** Each topic's quizzes (grouped by quiz id) plus when it was first studied. */
export function buildFitData(userId: number, tz: string): (FitTopic & { topicId: number })[] {
  const topics = db.prepare('SELECT t.id, t.difficulty FROM topics t JOIN subjects s ON s.id=t.subject_id WHERE s.user_id=?').all(userId) as { id: number; difficulty: number }[];
  const out: (FitTopic & { topicId: number })[] = [];
  for (const t of topics) {
    const rows = db.prepare('SELECT quiz_id, correct, confidence, response_ms, answered_at FROM attempts WHERE user_id=? AND topic_id=? ORDER BY answered_at').all(userId, t.id) as
      { quiz_id: string; correct: number; confidence: number; response_ms: number; answered_at: number }[];
    if (!rows.length) continue;
    const byQuiz = new Map<string, typeof rows>();
    for (const r of rows) {
      const key = r.quiz_id || `t${Math.floor(r.answered_at / 3600000)}`; // old rows without a quiz id: group by hour
      byQuiz.set(key, [...(byQuiz.get(key) ?? []), r]);
    }
    const first = db.prepare("SELECT start_ts FROM study_sessions WHERE user_id=? AND topic_id=? AND kind='learn' ORDER BY start_ts LIMIT 1").get(userId, t.id) as { start_ts: number } | undefined;
    out.push({
      topicId: t.id,
      difficulty: t.difficulty,
      context: first ? hourBucket(hourIn(first.start_ts, tz)) : null,
      quizzes: [...byQuiz.values()].map(list => ({
        at: list[0].answered_at,
        context: hourBucket(hourIn(list[0].answered_at, tz)),
        answers: list.map(r => ({ correct: Boolean(r.correct), confidence: r.confidence, responseMs: r.response_ms })),
      })),
    });
  }
  return out;
}

export function fitNow(userId: number, tz: string) {
  const n = (db.prepare('SELECT COUNT(*) n FROM attempts WHERE user_id=?').get(userId) as { n: number }).n;
  if (n < MIN_ANSWERS_TO_FIT) return null;
  const data = buildFitData(userId, tz);
  const median = medianResponse(userId);
  const r = fitUserParams(data, median);
  db.prepare(`INSERT INTO user_params(user_id,params_json,fitted_at,n_attempts,loss_default,loss_fitted) VALUES(?,?,?,?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET params_json=excluded.params_json, fitted_at=excluded.fitted_at, n_attempts=excluded.n_attempts,
    loss_default=excluded.loss_default, loss_fitted=excluded.loss_fitted`)
    .run(userId, JSON.stringify({ growth: r.params.growth, userPrior: r.params.userPrior, contextMult: r.params.contextMult }), Date.now(), n, r.lossDefault, r.lossFitted);
  // Recompute every topic's memory with the personal model, so all forecasts use it from now on.
  db.transaction(() => { for (const t of data) saveTopicState(t.topicId, replayTopic(t, r.params, median).state); })();
  return r;
}

export function maybeRefit(userId: number, tz: string) {
  const n = (db.prepare('SELECT COUNT(*) n FROM attempts WHERE user_id=?').get(userId) as { n: number }).n;
  if (n < MIN_ANSWERS_TO_FIT) return;
  const row = db.prepare('SELECT fitted_at, n_attempts FROM user_params WHERE user_id=?').get(userId) as { fitted_at: number; n_attempts: number } | undefined;
  if (!row || n - row.n_attempts >= REFIT_EVERY || Date.now() - row.fitted_at >= REFIT_AFTER) {
    try { fitNow(userId, tz); } catch (e) { console.error('[MODEL] fit failed', (e as Error).message); }
  }
}

export function modelStatus(userId: number) {
  const n = (db.prepare('SELECT COUNT(*) n FROM attempts WHERE user_id=?').get(userId) as { n: number }).n;
  const row = db.prepare('SELECT * FROM user_params WHERE user_id=?').get(userId) as
    { params_json: string; fitted_at: number; n_attempts: number; loss_default: number; loss_fitted: number } | undefined;
  if (!row) return { fitted: false as const, answers: n, needed: MIN_ANSWERS_TO_FIT };
  const p = JSON.parse(row.params_json) as Pick<PersonalParams, 'growth' | 'userPrior' | 'contextMult'>;
  return {
    fitted: true as const,
    answers: n,
    fittedOn: row.n_attempts,
    fittedAt: row.fitted_at,
    growth: p.growth, defaultGrowth: DEFAULT_PARAMS.growth,
    userPrior: p.userPrior,
    contextMult: p.contextMult,
    improvement: row.loss_default > 0 ? Math.max(0, (row.loss_default - row.loss_fitted) / row.loss_default) : 0,
  };
}
