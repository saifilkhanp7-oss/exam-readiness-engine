// Creates a demo student with three weeks of simulated study and quiz history.
// The history is replayed through the real memory engine, so every curve, forecast and insight is computed,
// not typed in. Run: npm run seed:demo  (email: demo@example.com)
import db from './db.ts';
import { saveGenerated } from './jobs.ts';
import { DEMO } from './demoContent.ts';
import {
  DAY, initialState, updateAfterQuiz, simulatePlan, startOfDay, type MemoryState, type SubjectInput,
} from '@ere/engine';
import { saveTopicState } from './store.ts';

const EMAIL = process.env.DEMO_EMAIL || 'demo@example.com';
const NAME = 'Saif Khan';
const TZ = process.env.DEMO_TZ || 'Asia/Kolkata';
const now = Date.now();
const HOUR = 3600 * 1000;

let seed = 20261018;
const rand = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
const gauss = () => Math.sqrt(-2 * Math.log(Math.max(rand(), 1e-9))) * Math.cos(2 * Math.PI * rand());

// --- reset demo user ---
const old = db.prepare('SELECT id FROM users WHERE email=?').get(EMAIL) as { id: number } | undefined;
if (old) db.prepare('DELETE FROM users WHERE id=?').run(old.id);
const userId = Number(db.prepare('INSERT INTO users(username,email,daily_minutes,created_at) VALUES(?,?,?,?)').run(NAME, EMAIL, 60, now - 25 * DAY).lastInsertRowid);

// --- subjects, topics, questions ---
type TopicMeta = { id: number; subjectId: number; title: string; difficulty: number; sim: (typeof DEMO)[number]['topics'][number]['sim'] };
const metas: TopicMeta[] = [];
for (const s of DEMO) {
  const examAt = startOfDay(now + s.examInDays * DAY) + 9.5 * HOUR;
  const sid = Number(db.prepare('INSERT INTO subjects(user_id,name,color,exam_at,total_marks,guess_rate,created_at) VALUES(?,?,?,?,?,0,?)')
    .run(userId, s.name, s.color, examAt, s.totalMarks, now - 25 * DAY).lastInsertRowid);
  saveGenerated(sid, null, s.topics.map(t => ({
    title: t.title, chapter: t.chapter, difficulty: t.difficulty, importance: t.marks, estLearnMin: t.minutes,
    pageFrom: t.pages[0], pageTo: t.pages[1], line: t.line, compact: t.compact, detailed: t.detailed, simple: t.simple,
    formulas: t.formulas,
    questions: t.qs.map(([prompt, options, answer, explanation, tags], k) => ({
      prompt, options, answer, explanation, distractorTopics: tags, page: t.pages[0] + Math.min(k, t.pages[1] - t.pages[0]),
    })),
  })));
  db.prepare("UPDATE topics SET weight_source='past_papers' WHERE subject_id=?").run(sid);
  for (const t of s.topics) {
    const row = db.prepare('SELECT id FROM topics WHERE subject_id=? AND title=?').get(sid, t.title) as { id: number };
    metas.push({ id: row.id, subjectId: sid, title: t.title, difficulty: t.difficulty, sim: t.sim });
  }
}

// --- simulate the study history ---
interface QuizEvent { at: number; topic: TopicMeta }
const events: QuizEvent[] = [];
const insSession = db.prepare('INSERT INTO study_sessions(user_id,subject_id,topic_id,start_ts,end_ts,kind) VALUES(?,?,?,?,?,?)');
for (const m of metas) {
  if (m.sim.learnedDaysAgo == null) continue;
  const day = startOfDay(now - m.sim.learnedDaysAgo * DAY);
  const startHour = m.sim.lateNight ? 23 + rand() * 0.6 : 10 + rand() * 8;
  const len = m.sim.lateNight ? 95 + rand() * 40 : 40 + rand() * 15;
  const start = day + startHour * HOUR;
  insSession.run(userId, m.subjectId, m.id, start, start + len * 60000, 'learn');
  // Second sitting on the same topic the next day, same habit.
  const start2 = start + DAY + (rand() - 0.5) * HOUR;
  insSession.run(userId, m.subjectId, m.id, start2, start2 + len * 0.6 * 60000, 'learn');
  events.push({ at: start + len * 60000 + 20 * 60000, topic: m });
  for (const off of [1, 3, 6, 10, 15]) {
    const at = day + off * DAY + (m.sim.lateNight ? 23.3 + rand() * 0.5 : 17 + rand() * 4) * HOUR;
    if (at < now - HOUR) events.push({ at, topic: m });
  }
}
events.sort((a, b) => a.at - b.at);

const questionsOf = new Map<number, { id: number; answer_idx: number; options_json: string }[]>();
for (const m of metas) questionsOf.set(m.id, db.prepare('SELECT id, answer_idx, options_json FROM questions WHERE topic_id=?').all(m.id) as any[]);
const tagsOf = (qid: number) => db.prepare('SELECT option_idx, topic_id FROM distractors WHERE question_id=?').all(qid) as { option_idx: number; topic_id: number }[];

const truth = new Map<number, { hl: number; last: number | null }>();
const states = new Map<number, MemoryState>();
// Late-night learning starts weaker (what the personal model should find).
for (const m of metas) { truth.set(m.id, { hl: m.sim.trueHalfLife * (m.sim.lateNight ? 0.7 : 1), last: null }); states.set(m.id, initialState(m.difficulty)); }

const insAttempt = db.prepare('INSERT INTO attempts(user_id,question_id,topic_id,confidence,chosen_idx,correct,response_ms,answered_at,quiz_id) VALUES(?,?,?,?,?,?,?,?,?)');
const upConf = db.prepare(`INSERT INTO confusions(user_id,topic_a,topic_b,count,exposures,last_at) VALUES(?,?,?,?,1,?)
  ON CONFLICT(user_id,topic_a,topic_b) DO UPDATE SET count=count+excluded.count, exposures=exposures+1, last_at=excluded.last_at`);
const rot = new Map<number, number>();

function runQuiz(e: QuizEvent) {
  const m = e.topic;
  const tr = truth.get(m.id)!;
  const tDays = tr.last == null ? 0 : (e.at - tr.last) / DAY;
  const pTrue = Math.max(0.05, m.sim.trueMastery * Math.pow(2, -tDays / tr.hl));
  const qs = questionsOf.get(m.id)!;
  const n = Math.min(4, qs.length);
  const answers: { correct: boolean; confidence: number; responseMs: number }[] = [];
  const quizId = `demo-${m.id}-${e.at}`;
  for (let k = 0; k < n; k++) {
    const i = rot.get(m.id) ?? 0; rot.set(m.id, i + 1);
    const q = qs[i % qs.length];
    const correct = rand() < pTrue;
    const tags = tagsOf(q.id).filter(x => x.topic_id !== m.id);
    let chosen = q.answer_idx;
    if (!correct) {
      const tagged = tags.filter(x => x.option_idx !== q.answer_idx);
      if (tagged.length && rand() < 0.8) chosen = tagged[Math.floor(rand() * tagged.length)].option_idx;
      else { const opts = JSON.parse(q.options_json).map((_: string, j: number) => j).filter((j: number) => j !== q.answer_idx); chosen = opts[Math.floor(rand() * opts.length)]; }
    }
    const confidence = m.sim.overconfident
      ? (rand() < 0.8 ? 4 : 5)
      : Math.min(5, Math.max(1, Math.round(5 * pTrue - 0.4 + gauss() * 0.5)));
    const responseMs = Math.round(6000 + rand() * 9000);
    insAttempt.run(userId, q.id, m.id, confidence, chosen, correct ? 1 : 0, responseMs, e.at + k * 20000, quizId);
    for (const tid of new Set(tags.map(x => x.topic_id)))
      upConf.run(userId, m.id, tid, !correct && tags.some(x => x.topic_id === tid && x.option_idx === chosen) ? 1 : 0, e.at);
    answers.push({ correct, confidence, responseMs });
  }
  const score = answers.filter(a => a.correct).length / answers.length;
  tr.hl *= score >= 0.6 ? 1.4 : 0.95;
  tr.last = e.at;
  states.set(m.id, updateAfterQuiz(states.get(m.id)!, answers, e.at, m.difficulty, 10500));
}

// Replay day by day and record the forecast each evening, exactly as the app would have shown it.
const subjects = db.prepare('SELECT * FROM subjects WHERE user_id=?').all(userId) as { id: number; name: string; exam_at: number; total_marks: number; guess_rate: number }[];
const inputFor = (): SubjectInput[] => subjects.map(s => ({
  id: s.id, name: s.name, examAt: s.exam_at, totalMarks: s.total_marks, guessRate: s.guess_rate,
  topics: metas.filter(m => m.subjectId === s.id).map(m => {
    const row = db.prepare('SELECT weight, est_learn_min FROM topics WHERE id=?').get(m.id) as { weight: number; est_learn_min: number };
    return { id: m.id, title: m.title, weight: row.weight, difficulty: m.difficulty, estLearnMin: row.est_learn_min, state: states.get(m.id)! };
  }),
}));
const dayKey = (ts: number) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(ts);
const insF = db.prepare('INSERT OR REPLACE INTO forecasts(user_id,subject_id,day,readiness,p10,p50,p90) VALUES(?,?,?,?,?,?,?)');

let ei = 0;
for (let day = startOfDay(now - 22 * DAY); day < startOfDay(now); day += DAY) {
  const end = day + 22 * HOUR;
  while (ei < events.length && events[ei].at <= end) runQuiz(events[ei++]);
  if (day >= startOfDay(now - 14 * DAY)) {
    const plan = simulatePlan(inputFor(), { now: end, dailyMinutes: 60 });
    for (const f of plan.forecasts) insF.run(userId, f.subjectId, dayKey(end), f.readiness, f.scoreP10, f.scoreP50, f.scoreP90);
  }
}
while (ei < events.length) runQuiz(events[ei++]);
for (const m of metas) if (states.get(m.id)!.lastReviewAt != null) saveTopicState(m.id, states.get(m.id)!);

const nAttempts = (db.prepare('SELECT COUNT(*) n FROM attempts WHERE user_id=?').get(userId) as { n: number }).n;
console.log(`Demo ready: ${EMAIL} — ${subjects.length} subjects, ${metas.length} topics, ${nAttempts} quiz answers replayed through the engine.`);

// The demo student has more than 100 answers, so the personal model is fitted, just as it would be in the app.
const { fitNow, modelStatus } = await import('./personalModel.ts');
const fit = fitNow(userId, TZ);
if (fit) console.log(`Personal model fitted: growth ${fit.params.growth}, start ×${fit.params.userPrior}, predictions ${(fit.improvement * 100).toFixed(1)}% better.`);
void modelStatus;
