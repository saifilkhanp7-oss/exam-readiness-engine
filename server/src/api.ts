import { Router } from 'express';
import multer from 'multer';
import crypto from 'node:crypto';
import path from 'node:path';
import db from './db.ts';
import { requireAuth } from './auth.ts';
import { UPLOAD_DIR } from './config.ts';
import {
  DAY, simulatePlan, triage, recallAt, fadeDays, updateAfterQuiz, calibrationByTopic, brier,
  activeConfusions, findPatterns, hourBucket, startOfDay, type MemoryState,
} from '@ere/engine';
import {
  engineInputs, ownSubject, ownTopic, paramsFor, saveItemState, saveTopicState, stateOf, subjectsOf,
  toSubjectInput, topicsOf, type ItemRow, type TopicRow,
} from './store.ts';
import { polishInsights, type Insight } from './ai.ts';
import { paperStats, reweightFromPapers } from './pastPapers.ts';
import { recordAnswer, finishQuiz } from './quizService.ts';
import { fitNow, maybeRefit, modelStatus } from './personalModel.ts';
import fs from 'node:fs';

export const api = Router();
api.use(requireAuth);

const COLORS = ['#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6'];
const DAY_KEY = (ts: number, tz: string) => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(ts);
const hourIn = (ts: number, tz: string) => Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hourCycle: 'h23' }).format(ts));

// ---------- settings ----------
api.patch('/me', (req, res) => {
  const dm = Number(req.body?.daily_minutes);
  const tr = Number(req.body?.target_recall);
  if (dm >= 10 && dm <= 720) db.prepare('UPDATE users SET daily_minutes=? WHERE id=?').run(Math.round(dm), req.user.id);
  if (tr >= 0.6 && tr <= 0.97) db.prepare('UPDATE users SET target_recall=? WHERE id=?').run(tr, req.user.id);
  res.json({ user: db.prepare('SELECT id, username, email, daily_minutes, target_recall FROM users WHERE id=?').get(req.user.id) });
});

// ---------- subjects ----------
api.get('/subjects', (req, res) => {
  const rows = subjectsOf(req.user.id).map(s => {
    const c = db.prepare('SELECT COUNT(*) n, SUM(last_review_at IS NOT NULL) studied FROM topics WHERE subject_id=?').get(s.id) as { n: number; studied: number };
    const src = db.prepare("SELECT COUNT(*) n, SUM(status IN ('queued','processing')) busy FROM sources WHERE subject_id=?").get(s.id) as { n: number; busy: number };
    return { ...s, topic_count: c.n, studied_count: c.studied ?? 0, source_count: src.n, processing: (src.busy ?? 0) > 0 };
  });
  res.json({ subjects: rows });
});

// The "+" button can add several subjects at once.
api.post('/subjects', (req, res) => {
  const list = Array.isArray(req.body?.subjects) ? req.body.subjects : [req.body];
  const used = (db.prepare('SELECT COUNT(*) n FROM subjects WHERE user_id=?').get(req.user.id) as { n: number }).n;
  const created: number[] = [];
  const errors: string[] = [];
  db.transaction(() => {
    list.slice(0, 20).forEach((s: any, i: number) => {
      const name = String(s?.name || '').trim();
      const examAt = Number(new Date(s?.examAt).getTime());
      if (!name || name.length > 60) return errors.push(`Row ${i + 1}: subject name is required`);
      if (!examAt || examAt < Date.now() - DAY) return errors.push(`${name}: pick an exam date in the future`);
      const totalMarks = Math.min(1000, Math.max(1, Number(s.totalMarks) || 100));
      const info = db.prepare('INSERT INTO subjects(user_id,name,color,exam_at,total_marks,guess_rate,created_at) VALUES(?,?,?,?,?,?,?)')
        .run(req.user.id, name, s.color || COLORS[(used + created.length) % COLORS.length], examAt, totalMarks, s.mcq ? 0.25 : 0, Date.now());
      const sid = Number(info.lastInsertRowid);
      const titles: string[] = (Array.isArray(s.topics) ? s.topics : String(s.topics || '').split('\n')).map((t: string) => t.trim()).filter(Boolean);
      titles.slice(0, 200).forEach((t, k) => db.prepare('INSERT INTO topics(subject_id,title,order_idx) VALUES(?,?,?)').run(sid, t.slice(0, 120), k));
      created.push(sid);
    });
  })();
  if (!created.length) return res.status(400).json({ error: errors[0] || 'Nothing to add' });
  res.json({ created, errors });
});

api.patch('/subjects/:id', (req, res) => {
  const s = ownSubject(req.user.id, Number(req.params.id));
  if (!s) return res.status(404).json({ error: 'Not found' });
  const b = req.body || {};
  db.prepare('UPDATE subjects SET name=?, exam_at=?, total_marks=?, color=?, guess_rate=? WHERE id=?').run(
    String(b.name ?? s.name).slice(0, 60), b.examAt ? new Date(b.examAt).getTime() : s.exam_at,
    Number(b.totalMarks ?? s.total_marks), String(b.color ?? s.color), b.mcq == null ? s.guess_rate : b.mcq ? 0.25 : 0, s.id);
  res.json({ ok: true });
});

api.delete('/subjects/:id', (req, res) => {
  db.prepare('DELETE FROM subjects WHERE id=? AND user_id=?').run(Number(req.params.id), req.user.id);
  res.json({ ok: true });
});

function topicView(t: TopicRow, now: number, extra: { recallOnExam?: number; danger?: boolean; calib?: { expectedPct: number; accuracyPct: number; n: number } } = {}) {
  const st = stateOf(t, t.difficulty);
  return {
    id: t.id, title: t.title, chapter: t.chapter, weight: t.weight, weight_source: t.weight_source,
    difficulty: t.difficulty, est_learn_min: t.est_learn_min, skip: Boolean(t.skip),
    page_from: t.page_from, page_to: t.page_to,
    studied: t.last_review_at != null,
    recall_now: t.last_review_at == null ? 0 : recallAt(st, now),
    half_life: t.last_review_at == null ? null : st.halfLife,
    fade_days: fadeDays(st, now),
    mastery: t.mastery,
    n_reviews: t.n_reviews,
    question_count: (db.prepare('SELECT COUNT(*) n FROM questions WHERE topic_id=?').get(t.id) as { n: number }).n,
    recall_on_exam: extra.recallOnExam ?? null,
    danger: Boolean(extra.danger),
    calibration: extra.calib ?? null,
  };
}

function userCalibration(userId: number) {
  const attempts = (db.prepare('SELECT topic_id, confidence, correct, answered_at FROM attempts WHERE user_id=?').all(userId) as any[])
    .map(a => ({ topicId: a.topic_id, confidence: a.confidence, correct: Boolean(a.correct), answeredAt: a.answered_at }));
  return { attempts, byTopic: new Map(calibrationByTopic(attempts).map(c => [c.topicId, c])) };
}

api.get('/subjects/:id', (req, res) => {
  const s = ownSubject(req.user.id, Number(req.params.id));
  if (!s) return res.status(404).json({ error: 'Not found' });
  const now = Date.now();
  const topics = topicsOf(s.id);
  const input = toSubjectInput(s, topics);
  const plan = s.exam_at > now ? simulatePlan(engineInputs(req.user.id, now), { now, dailyMinutes: req.user.daily_minutes, params: paramsFor(req.user) }) : null;
  const fc = plan?.forecasts.find(f => f.subjectId === s.id);
  const recallMap = new Map(fc?.topics.map(t => [t.id, t.recallOnExam]) ?? []);
  const { byTopic } = userCalibration(req.user.id);
  const sources = db.prepare("SELECT id, title, kind, pages, status, progress, error, ocr_pages, year, created_at FROM sources WHERE subject_id=? ORDER BY id DESC").all(s.id);
  const papers = paperStats(s.id);
  res.json({
    subject: s,
    forecast: fc ?? null,
    triage: s.exam_at > now ? triage(input, now, req.user.daily_minutes, paramsFor(req.user)) : null,
    topics: topics.map(t => {
      const c = byTopic.get(t.id);
      const p = papers.byTopic.get(t.id);
      return { ...topicView(t, now, { recallOnExam: recallMap.get(t.id), danger: c?.dangerous, calib: c && { expectedPct: c.expectedPct, accuracyPct: c.accuracyPct, n: c.n } }),
        paper_count: p?.n ?? 0, paper_marks: p?.marks ?? 0 };
    }),
    sources,
    papers: papers.papers,
    unmatchedQuestions: papers.unmatched,
  });
});

api.post('/subjects/:id/topics', (req, res) => {
  const s = ownSubject(req.user.id, Number(req.params.id));
  if (!s) return res.status(404).json({ error: 'Not found' });
  const titles: string[] = (req.body?.titles || []).map((t: string) => String(t).trim()).filter(Boolean).slice(0, 200);
  let idx = (db.prepare('SELECT COALESCE(MAX(order_idx),-1)+1 n FROM topics WHERE subject_id=?').get(s.id) as { n: number }).n;
  for (const t of titles) db.prepare('INSERT INTO topics(subject_id,title,order_idx) VALUES(?,?,?)').run(s.id, t.slice(0, 120), idx++);
  res.json({ ok: true, added: titles.length });
});

api.patch('/topics/:id', (req, res) => {
  const t = ownTopic(req.user.id, Number(req.params.id));
  if (!t) return res.status(404).json({ error: 'Not found' });
  const b = req.body || {};
  db.prepare('UPDATE topics SET title=?, weight=?, weight_source=?, difficulty=?, est_learn_min=?, skip=? WHERE id=?').run(
    String(b.title ?? t.title).slice(0, 120),
    b.weight != null ? Math.max(0, Number(b.weight)) : t.weight,
    b.weight != null ? 'manual' : t.weight_source,
    b.difficulty != null ? Math.min(1, Math.max(0, Number(b.difficulty))) : t.difficulty,
    b.est_learn_min != null ? Math.max(5, Number(b.est_learn_min)) : t.est_learn_min,
    b.skip != null ? (b.skip ? 1 : 0) : t.skip, t.id);
  res.json({ ok: true });
});

api.delete('/topics/:id', (req, res) => {
  const t = ownTopic(req.user.id, Number(req.params.id));
  if (t) db.prepare('DELETE FROM topics WHERE id=?').run(t.id);
  res.json({ ok: true });
});

// ---------- uploads ----------
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (_req, _f, cb) => cb(null, `${crypto.randomUUID()}.pdf`),
  }),
  limits: { fileSize: 200 * 1024 * 1024, files: 10 },
  fileFilter: (_req, f, cb) => cb(null, f.mimetype === 'application/pdf' || f.originalname.toLowerCase().endsWith('.pdf')),
});

api.post('/subjects/:id/sources', upload.array('files', 10), (req, res) => {
  const s = ownSubject(req.user.id, Number(req.params.id));
  if (!s) return res.status(404).json({ error: 'Not found' });
  const files = (req.files as Express.Multer.File[]) || [];
  if (!files.length) return res.status(400).json({ error: 'Please choose PDF files.' });
  const kind = req.body?.kind === 'past_paper' ? 'past_paper' : 'pdf';
  const ids = files.map(f => Number(db.prepare('INSERT INTO sources(user_id,subject_id,kind,title,file_name,status,created_at) VALUES(?,?,?,?,?,?,?)')
    .run(req.user.id, s.id, kind, path.basename(f.originalname, '.pdf').slice(0, 120), f.filename, 'queued', Date.now()).lastInsertRowid));
  res.json({ ids });
});

api.delete('/sources/:id', (req, res) => {
  const src = db.prepare('SELECT * FROM sources WHERE id=? AND user_id=?').get(Number(req.params.id), req.user.id) as { id: number; subject_id: number; kind: string; file_name: string } | undefined;
  if (!src) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM sources WHERE id=?').run(src.id);
  try { fs.unlinkSync(path.join(UPLOAD_DIR, src.file_name)); } catch { /* already gone */ }
  if (src.kind === 'past_paper') reweightFromPapers(src.subject_id);
  res.json({ ok: true });
});

// Fix a question the matcher could not place (or placed wrongly).
api.patch('/paper-questions/:id', (req, res) => {
  const q = db.prepare('SELECT q.*, s.user_id FROM paper_questions q JOIN subjects s ON s.id=q.subject_id WHERE q.id=?').get(Number(req.params.id)) as { id: number; subject_id: number; user_id: number } | undefined;
  if (!q || q.user_id !== req.user.id) return res.status(404).json({ error: 'Not found' });
  const topicId = req.body?.topicId ? Number(req.body.topicId) : null;
  if (topicId && !db.prepare('SELECT 1 FROM topics WHERE id=? AND subject_id=?').get(topicId, q.subject_id)) return res.status(400).json({ error: 'Topic not in this subject' });
  db.prepare('UPDATE paper_questions SET topic_id=?, match_score=1 WHERE id=?').run(topicId, q.id);
  reweightFromPapers(q.subject_id);
  res.json({ ok: true });
});

api.get('/sources/:id', (req, res) => {
  const r = db.prepare('SELECT id, subject_id, title, pages, status, progress, error FROM sources WHERE id=? AND user_id=?').get(Number(req.params.id), req.user.id);
  if (!r) return res.status(404).json({ error: 'Not found' });
  res.json({ source: r });
});

// ---------- forecast + plan ----------
function insightsFor(userId: number, tz: string, plan: ReturnType<typeof simulatePlan> | null, now: number) {
  const items: Insight[] = [];
  const { attempts, byTopic } = userCalibration(userId);
  const topicRows = db.prepare('SELECT t.*, s.exam_at, s.name subject_name FROM topics t JOIN subjects s ON s.id=t.subject_id WHERE s.user_id=?').all(userId) as (TopicRow & { exam_at: number; subject_name: string })[];
  const title = new Map(topicRows.map(t => [t.id, t.title]));

  const dangers = [...byTopic.values()].filter(c => c.dangerous && title.has(c.topicId)).sort((a, b) => b.gap - a.gap);
  for (const d of dangers.slice(0, 3)) items.push({ kind: 'danger', topic: title.get(d.topicId)!, confidence: d.expectedPct, accuracy: d.accuracyPct });

  const conf = activeConfusions((db.prepare('SELECT topic_a topicA, topic_b topicB, count, exposures FROM confusions WHERE user_id=?').all(userId) as any[]));
  const seenPair = new Set<string>();
  for (const c of conf) {
    const key = [c.topicA, c.topicB].sort().join('-');
    if (seenPair.has(key) || !title.has(c.topicA) || !title.has(c.topicB)) continue;
    seenPair.add(key);
    if (seenPair.size > 2) break;
    items.push({ kind: 'confusion', a: title.get(c.topicA)!, b: title.get(c.topicB)!, count: c.count });
  }

  // Fastest-fading studied topics with an upcoming exam.
  const fading = topicRows.filter(t => t.last_review_at != null && t.exam_at > now)
    .map(t => ({ t, days: (t.half_life ?? 1) }))
    .sort((a, b) => a.days - b.days).slice(0, 2);
  for (const f of fading) {
    const reviews = plan?.tasks.filter(x => x.topicId === f.t.id && x.kind === 'review').length ?? 0;
    items.push({ kind: 'fade', topic: f.t.title, days: f.days, reviewsNeeded: Math.max(1, reviews) });
  }

  // Study-time patterns from the timer.
  const sessions = db.prepare(`SELECT ss.start_ts, ss.end_ts, t.half_life FROM study_sessions ss JOIN topics t ON t.id=ss.topic_id
    WHERE ss.user_id=? AND ss.kind='learn' AND t.half_life IS NOT NULL AND t.n_reviews >= 2`).all(userId) as { start_ts: number; end_ts: number; half_life: number }[];
  const byHour = findPatterns(sessions.map(s => ({ bucket: hourBucket(hourIn(s.start_ts, tz)), halfLife: s.half_life })));
  const byLen = findPatterns(sessions.filter(s => s.end_ts).map(s => {
    const m = (s.end_ts - s.start_ts) / 60000;
    return { bucket: m <= 60 ? 'short sessions (under 1 hour)' : 'long sessions (over 1 hour)', halfLife: s.half_life };
  }));
  const patterns = [...byHour, ...byLen].map(p => p.ratio >= 1 ? p : { ...p, a: p.b, b: p.a, ratio: 1 / p.ratio });
  // Only the clearest pattern, so the list stays short.
  for (const p of patterns.sort((x, y) => y.ratio - x.ratio).slice(0, 1)) items.push({ kind: 'pattern', a: p.a, b: p.b, pct: (p.ratio - 1) * 100 });

  return { items, dangers, confusions: [...seenPair].length, brier: brier(attempts), patterns, title };
}

api.get('/forecast', async (req, res) => {
  const now = Date.now();
  const inputs = engineInputs(req.user.id, now);
  const plan = inputs.length ? simulatePlan(inputs, { now, dailyMinutes: req.user.daily_minutes, params: paramsFor(req.user) }) : null;
  const today = DAY_KEY(now, req.tz);
  const up = db.prepare(`INSERT INTO forecasts(user_id,subject_id,day,readiness,p10,p50,p90) VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(user_id,subject_id,day) DO UPDATE SET readiness=excluded.readiness,p10=excluded.p10,p50=excluded.p50,p90=excluded.p90`);
  for (const f of plan?.forecasts ?? []) up.run(req.user.id, f.subjectId, today, f.readiness, f.scoreP10, f.scoreP50, f.scoreP90);
  const history = db.prepare('SELECT subject_id, day, readiness, p10, p50, p90 FROM forecasts WHERE user_id=? ORDER BY day DESC LIMIT 400').all(req.user.id) as any[];

  const ins = insightsFor(req.user.id, req.tz, plan, now);
  const sentences = await polishInsights(ins.items);
  const titles = new Map<number, { title: string; subjectId: number }>();
  for (const s of inputs) for (const t of s.topics) titles.set(t.id, { title: t.title, subjectId: s.id });
  const todayStart = startOfDay(now);
  const tasks = (plan?.tasks ?? []).filter(t => t.day < todayStart + 7 * DAY).map(t => ({ ...t, title: titles.get(t.topicId)?.title }));

  res.json({
    subjects: subjectsOf(req.user.id),
    forecasts: plan?.forecasts.map(({ topics, ...f }) => f) ?? [],
    history: history.reverse(),
    tasks,
    insights: ins.items.map((it, i) => ({ ...it, text: sentences[i] })),
    dangerCount: ins.dangers.length,
    dailyMinutes: req.user.daily_minutes,
  });
});

// Raw engine inputs so the browser can run the what-if simulator itself.
api.get('/simulate-input', (req, res) => {
  res.json({ subjects: engineInputs(req.user.id), dailyMinutes: req.user.daily_minutes, params: paramsFor(req.user), now: Date.now() });
});

// ---------- quiz ----------
api.get('/quiz', (req, res) => {
  const mode = String(req.query.mode || 'due');
  const n = Math.min(20, Math.max(3, Number(req.query.n) || 8));
  const subjectId = Number(req.query.subjectId) || null;
  const topicId = Number(req.query.topicId) || null;
  const now = Date.now();
  let topicIds: number[] = [];

  const userTopics = db.prepare(`SELECT t.* FROM topics t JOIN subjects s ON s.id=t.subject_id WHERE s.user_id=? AND (? IS NULL OR s.id=?) AND t.skip=0`)
    .all(req.user.id, subjectId, subjectId) as TopicRow[];

  let pairs: [number, number][] = [];
  if (topicId) topicIds = userTopics.some(t => t.id === topicId) ? [topicId] : [];
  else if (mode === 'danger') {
    const { byTopic } = userCalibration(req.user.id);
    topicIds = userTopics.filter(t => byTopic.get(t.id)?.dangerous).map(t => t.id);
  } else if (mode === 'contrast') {
    const a = Number(req.query.a), b = Number(req.query.b);
    if (a && b) pairs = [[a, b]];
    else {
      const rows = activeConfusions(db.prepare('SELECT topic_a topicA, topic_b topicB, count, exposures FROM confusions WHERE user_id=?').all(req.user.id) as any[]);
      if (rows[0]) pairs = [[rows[0].topicA, rows[0].topicB]];
    }
    topicIds = pairs.flat().filter(id => userTopics.some(t => t.id === id));
  } else {
    // Due: lowest recall first among studied topics, then a few new ones.
    const studied = userTopics.filter(t => t.last_review_at != null)
      .map(t => ({ id: t.id, r: recallAt(stateOf(t, t.difficulty), now) })).sort((a, b) => a.r - b.r);
    topicIds = studied.filter(x => x.r < 0.9).slice(0, 4).map(x => x.id);
    if (topicIds.length < 2) topicIds.push(...userTopics.filter(t => t.last_review_at == null).slice(0, 2).map(t => t.id));
    if (!topicIds.length) topicIds = studied.slice(0, 3).map(x => x.id);
  }
  if (!topicIds.length) return res.json({ quizId: null, questions: [], message: 'Nothing to quiz yet. Add topics or upload a PDF first.' });

  const ph = topicIds.map(() => '?').join(',');
  let qs = db.prepare(`SELECT q.id, q.topic_id, q.prompt, q.options_json, q.type, q.page_ref, t.title topic_title FROM questions q JOIN topics t ON t.id=q.topic_id WHERE q.topic_id IN (${ph})`).all(...topicIds) as any[];
  if (mode === 'contrast' && pairs.length) {
    // Prefer questions whose wrong options come from the partner topic.
    const [a, b] = pairs[0];
    const contrast = qs.filter(q => db.prepare('SELECT 1 FROM distractors WHERE question_id=? AND topic_id=?').get(q.id, q.topic_id === a ? b : a));
    if (contrast.length >= 3) qs = contrast;
  }
  // Least recently answered first, then shuffle a bit.
  const lastSeen = new Map((db.prepare(`SELECT question_id, MAX(answered_at) m FROM attempts WHERE user_id=? GROUP BY question_id`).all(req.user.id) as any[]).map(r => [r.question_id, r.m]));
  qs.sort((x, y) => (lastSeen.get(x.id) ?? 0) - (lastSeen.get(y.id) ?? 0) || Math.random() - 0.5);
  // Spread across topics.
  const picked: any[] = [];
  const perTopic = new Map<number, number>();
  for (const q of qs) {
    if (picked.length >= n) break;
    const c = perTopic.get(q.topic_id) ?? 0;
    if (c >= Math.ceil(n / topicIds.length) + 1) continue;
    perTopic.set(q.topic_id, c + 1);
    picked.push(q);
  }
  res.json({
    quizId: crypto.randomUUID(),
    mode,
    pair: pairs[0] ?? null,
    questions: picked.map(q => ({ id: q.id, topicId: q.topic_id, topicTitle: q.topic_title, prompt: q.prompt, options: JSON.parse(q.options_json), page: q.page_ref })),
  });
});

api.post('/quiz/answer', (req, res) => {
  const r = recordAnswer(req.user.id, req.body || {});
  if (!r) return res.status(404).json({ error: 'Question not found' });
  res.json(r);
});

api.post('/quiz/finish', (req, res) => {
  const results = finishQuiz(req.user, String(req.body?.quizId || ''), req.tz);
  if (!results) return res.status(400).json({ error: 'No answers in this quiz' });
  maybeRefit(req.user.id, req.tz);
  res.json({ results });
});

// Offline: everything needed to quiz without a connection (answers included; this is a self-test app).
api.get('/quiz/pack', (req, res) => {
  const now = Date.now();
  const topics = db.prepare(`SELECT t.*, s.name subject_name FROM topics t JOIN subjects s ON s.id=t.subject_id
    WHERE s.user_id=? AND t.skip=0 AND s.exam_at > ?`).all(req.user.id, now - DAY) as (TopicRow & { subject_name: string })[];
  const { byTopic } = userCalibration(req.user.id);
  const ids = topics.map(t => t.id);
  const qs = ids.length ? db.prepare(`SELECT id, topic_id, prompt, options_json, answer_idx, explanation, page_ref FROM questions WHERE topic_id IN (${ids.map(() => '?').join(',')})`).all(...ids) as any[] : [];
  const titles = new Map(topics.map(t => [t.id, t.title]));
  const tags = new Map<number, { option_idx: number; topic_id: number }[]>();
  for (const d of (qs.length ? db.prepare(`SELECT question_id, option_idx, topic_id FROM distractors WHERE question_id IN (${qs.map(() => '?').join(',')})`).all(...qs.map(q => q.id)) : []) as any[])
    tags.set(d.question_id, [...(tags.get(d.question_id) ?? []), d]);
  res.json({
    builtAt: now,
    topics: topics.map(t => ({
      id: t.id, title: t.title, subjectId: t.subject_id, subject: t.subject_name,
      recall: t.last_review_at == null ? null : recallAt(stateOf(t, t.difficulty), now),
      danger: Boolean(byTopic.get(t.id)?.dangerous),
    })),
    questions: qs.map(q => ({
      id: q.id, topicId: q.topic_id, topicTitle: titles.get(q.topic_id), prompt: q.prompt, options: JSON.parse(q.options_json),
      answerIdx: q.answer_idx, explanation: q.explanation, page: q.page_ref,
      optionTopics: (tags.get(q.id) ?? []).filter(d => d.topic_id !== q.topic_id).map(d => ({ idx: d.option_idx, title: titles.get(d.topic_id) ?? null })),
    })),
  });
});

// Offline answers arrive here when the phone is back online. Each quiz is applied once (by quiz id).
api.post('/quiz/sync', (req, res) => {
  const quizzes = Array.isArray(req.body?.quizzes) ? req.body.quizzes.slice(0, 200) : [];
  let applied = 0, skipped = 0;
  for (const qz of quizzes) {
    const quizId = String(qz?.quizId || '');
    if (!quizId || !Array.isArray(qz.answers) || !qz.answers.length) { skipped++; continue; }
    if (db.prepare('SELECT 1 FROM attempts WHERE user_id=? AND quiz_id=? LIMIT 1').get(req.user.id, quizId)) { skipped++; continue; }
    db.transaction(() => {
      for (const a of qz.answers) recordAnswer(req.user.id, { ...a, quizId });
      finishQuiz(req.user, quizId, req.tz);
    })();
    applied++;
  }
  if (applied) maybeRefit(req.user.id, req.tz);
  res.json({ applied, skipped });
});

// Personal memory model status.
api.get('/model', (req, res) => { res.json(modelStatus(req.user.id)); });
api.post('/model/refit', (req, res) => {
  const r = fitNow(req.user.id, req.tz);
  if (!r) return res.status(400).json({ error: 'Answer at least 100 quiz questions first.' });
  res.json(modelStatus(req.user.id));
});

// ---------- study timer ----------
api.post('/sessions', (req, res) => {
  const { topicId, subjectId, start, end, kind } = req.body || {};
  const t = topicId ? ownTopic(req.user.id, Number(topicId)) : undefined;
  db.prepare('INSERT INTO study_sessions(user_id,subject_id,topic_id,start_ts,end_ts,kind) VALUES(?,?,?,?,?,?)')
    .run(req.user.id, t?.subject_id ?? (Number(subjectId) || null), t?.id ?? null, Number(start) || Date.now(), Number(end) || null, kind === 'review' ? 'review' : 'learn');
  res.json({ ok: true });
});

// ---------- notes ----------
api.get('/notes/:subjectId', (req, res) => {
  const s = ownSubject(req.user.id, Number(req.params.subjectId));
  if (!s) return res.status(404).json({ error: 'Not found' });
  const now = Date.now();
  const topics = topicsOf(s.id);
  const plan = s.exam_at > now ? simulatePlan(engineInputs(req.user.id, now), { now, dailyMinutes: req.user.daily_minutes, params: paramsFor(req.user) }) : null;
  const fc = plan?.forecasts.find(f => f.subjectId === s.id);
  const recallOnExam = new Map(fc?.topics.map(t => [t.id, t.recallOnExam]) ?? []);
  const { byTopic } = userCalibration(req.user.id);

  // "Last night": predicted recall by tomorrow (or exam time, if sooner) without more study.
  const lastNightAt = Math.min(s.exam_at, now + DAY);

  const notes = topics.map(t => {
    const st = stateOf(t, t.difficulty);
    const rExam = recallOnExam.get(t.id) ?? (t.last_review_at ? recallAt(st, s.exam_at) : 0);
    const danger = Boolean(byTopic.get(t.id)?.dangerous);
    const level = !t.last_review_at || danger || rExam < 0.6 ? 'detailed' : rExam >= 0.85 && t.mastery >= 0.8 ? 'line' : 'compact';
    return {
      id: t.id, title: t.title, chapter: t.chapter, level, danger,
      recall_on_exam: rExam, recall_now: t.last_review_at ? recallAt(st, now) : 0,
      recall_tomorrow: t.last_review_at ? recallAt(st, lastNightAt) : 0,
      studied: t.last_review_at != null,
      line: t.note_line, compact: t.note_compact, detailed: t.note_detailed, simple: t.note_simple,
      page_from: t.page_from, page_to: t.page_to,
    };
  });

  const items = db.prepare('SELECT i.*, t.difficulty, t.title topic_title, t.half_life t_hl, t.mastery t_m, t.last_review_at t_last, t.n_reviews t_n, t.hl_unc t_unc FROM items i JOIN topics t ON t.id=i.topic_id WHERE t.subject_id=?').all(s.id) as any[];
  const formulas = items.map(i => {
    // A formula never quizzed on its own inherits its topic's memory.
    const st: MemoryState = i.last_review_at != null ? stateOf(i, i.difficulty)
      : stateOf({ half_life: i.t_hl, mastery: i.t_m, last_review_at: i.t_last, n_reviews: i.t_n, hl_unc: i.t_unc }, i.difficulty);
    // Same basis as the notes: recall on exam day if you follow the plan.
    const planned = i.last_review_at == null ? recallOnExam.get(i.topic_id) : undefined;
    return {
      id: i.id, name: i.name, latex: i.latex, meaning: i.meaning, topic: i.topic_title, topicId: i.topic_id,
      recall_on_exam: st.lastReviewAt == null ? 0 : planned ?? recallAt(st, s.exam_at),
      recall_tomorrow: st.lastReviewAt == null ? 0 : recallAt(st, lastNightAt),
      studied: st.lastReviewAt != null,
    };
  }).sort((a, b) => a.recall_on_exam - b.recall_on_exam);

  const lastNight = {
    at: lastNightAt,
    topics: notes.filter(n => n.studied && n.recall_tomorrow < 0.7).sort((a, b) => a.recall_tomorrow - b.recall_tomorrow),
    formulas: formulas.filter(f => f.studied && f.recall_tomorrow < 0.7),
  };

  const confusionPairs = activeConfusions(db.prepare('SELECT topic_a topicA, topic_b topicB, count, exposures FROM confusions WHERE user_id=?').all(req.user.id) as any[])
    .filter(c => topics.some(t => t.id === c.topicA) && topics.some(t => t.id === c.topicB));

  res.json({ subject: s, notes, formulas, lastNight, confusionPairs });
});

// ---------- insights ----------
api.get('/insights', async (req, res) => {
  const now = Date.now();
  const inputs = engineInputs(req.user.id, now);
  const plan = inputs.length ? simulatePlan(inputs, { now, dailyMinutes: req.user.daily_minutes, params: paramsFor(req.user) }) : null;
  const ins = insightsFor(req.user.id, req.tz, plan, now);
  const sentences = await polishInsights(ins.items);
  const { byTopic } = userCalibration(req.user.id);
  const calib = [...byTopic.values()].filter(c => ins.title.has(c.topicId)).map(c => ({ ...c, title: ins.title.get(c.topicId) })).sort((a, b) => b.gap - a.gap);
  const pairs = activeConfusions(db.prepare('SELECT topic_a topicA, topic_b topicB, count, exposures FROM confusions WHERE user_id=?').all(req.user.id) as any[])
    .filter(c => ins.title.has(c.topicA) && ins.title.has(c.topicB))
    .map(c => ({ ...c, a: ins.title.get(c.topicA), b: ins.title.get(c.topicB) }));
  res.json({ insights: ins.items.map((it, i) => ({ ...it, text: sentences[i] })), calibration: calib, confusions: pairs, brier: ins.brier, patterns: ins.patterns });
});
