import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DAY, recall, initialState, updateAfterQuiz, nextReviewAt, simulatePlan, triage,
  calibrationByTopic, findPatterns, type SubjectInput, type QuizAnswer,
} from './index.ts';

const ans = (correct: number, total: number, conf = 3): QuizAnswer[] =>
  Array.from({ length: total }, (_, i) => ({ correct: i < correct, confidence: conf, responseMs: 8000 }));

test('recall halves every half-life', () => {
  assert.equal(recall(4, 0), 1);
  assert.ok(Math.abs(recall(4, 4) - 0.5) < 1e-9);
  assert.ok(Math.abs(recall(4, 8) - 0.25) < 1e-9);
});

test('first quiz sets mastery and starts the clock', () => {
  const s = updateAfterQuiz(initialState(0.5), ans(4, 5), 0, 0.5, 8000);
  assert.ok(Math.abs(s.mastery - 0.8) < 1e-9);
  assert.equal(s.lastReviewAt, 0);
});

test('good delayed recall makes half-life grow, bad recall shrinks it', () => {
  const start = updateAfterQuiz(initialState(0.5), ans(5, 5), 0, 0.5, 8000);
  const good = updateAfterQuiz(start, ans(4, 5), 2 * DAY, 0.5, 8000);
  const bad = updateAfterQuiz(start, ans(1, 5), 2 * DAY, 0.5, 8000);
  assert.ok(good.halfLife > start.halfLife, `good ${good.halfLife} vs ${start.halfLife}`);
  assert.ok(bad.halfLife < start.halfLife, `bad ${bad.halfLife} vs ${start.halfLife}`);
});

test('perfect scores do not make half-life explode', () => {
  let s = updateAfterQuiz(initialState(0.4), ans(4, 4), 0, 0.4, 8000);
  let at = 0;
  for (const gap of [1, 2, 3, 5, 8]) { at += gap * DAY; s = updateAfterQuiz(s, ans(4, 4), at, 0.4, 8000); }
  assert.ok(s.halfLife < 40, `half-life ${s.halfLife}`);
  assert.ok(s.halfLife > 8, `half-life ${s.halfLife}`);
});

test('next review comes when recall hits 85%', () => {
  const s = { ...initialState(0.5), halfLife: 10, lastReviewAt: 0, mastery: 0.8 };
  const at = nextReviewAt(s, 0.85)!;
  assert.ok(Math.abs(recall(10, at / DAY) - 0.85) < 1e-9);
});

const subject = (examInDays: number, n = 12): SubjectInput => ({
  id: 1, name: 'Physics', examAt: examInDays * DAY + 9 * 3600 * 1000, totalMarks: 100, guessRate: 0,
  topics: Array.from({ length: n }, (_, i) => ({
    id: i + 1, title: `T${i + 1}`, weight: i < 3 ? 3 : 1, difficulty: 0.5, estLearnMin: 60,
    state: initialState(0.5),
  })),
});

test('more study time gives higher readiness', () => {
  const s = subject(14);
  const one = simulatePlan([s], { now: 0, dailyMinutes: 60 }).forecasts[0];
  const two = simulatePlan([s], { now: 0, dailyMinutes: 120 }).forecasts[0];
  assert.ok(two.readiness > one.readiness, `${two.readiness} > ${one.readiness}`);
  assert.ok(one.scoreP10 <= one.scoreP50 && one.scoreP50 <= one.scoreP90);
});

test('planner learns heavy topics first', () => {
  const plan = simulatePlan([subject(14)], { now: 0, dailyMinutes: 60 });
  const firstLearn = plan.tasks.find(t => t.kind === 'learn')!;
  assert.ok(firstLearn.topicId <= 3);
});

test('triage switches on when time is short and skips low-value topics', () => {
  const r = triage(subject(2), 0, 60);
  assert.equal(r.active, true);
  assert.ok(r.items.some(i => i.decision === 'skip'));
  assert.ok(r.items[0].marksPerHour >= r.items[r.items.length - 1].marksPerHour);
});

test('overconfidence is flagged as dangerous', () => {
  const attempts = Array.from({ length: 10 }, (_, i) => ({ topicId: 7, confidence: 4, correct: i < 5, answeredAt: i }));
  const c = calibrationByTopic(attempts)[0];
  assert.equal(c.dangerous, true);
  assert.equal(Math.round(c.gap), 30);
});

test('patterns only reported when the difference is real', () => {
  const night = Array.from({ length: 12 }, (_, i) => ({ bucket: 'late night', halfLife: 2 + (i % 3) * 0.2 }));
  const day = Array.from({ length: 12 }, (_, i) => ({ bucket: 'morning', halfLife: 4 + (i % 3) * 0.2 }));
  assert.equal(findPatterns([...night, ...day]).length, 1);
  const same = Array.from({ length: 12 }, (_, i) => ({ bucket: 'evening', halfLife: 2 + (i % 3) * 0.2 }));
  assert.equal(findPatterns([...night, ...same]).length, 0);
});

test('fitting recovers a student whose memory lasts longer than the default guess', async () => {
  const { fitUserParams, MIN_ANSWERS_TO_FIT } = await import('./fit.ts');
  let seed = 7;
  const rand = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  const topics = Array.from({ length: 24 }, (_, i) => {
    const night = i % 2 === 0;
    let hl = night ? 5 : 6;              // true half-life, much longer than the default start (~1.7 days)
    let last = 0;
    const quizzes = [0, 1, 3, 6, 10].map(d => {
      const at = d * DAY + i * 1000;
      const p = 0.85 * Math.pow(2, -(at - last) / DAY / hl);
      const answers = Array.from({ length: 4 }, () => ({ correct: rand() < p, confidence: 3, responseMs: 9000 }));
      if (d > 0) { hl *= 1.5; last = at; } else last = at;
      return { at, answers };
    });
    return { difficulty: 0.5, context: night ? 'late night' : 'afternoon', quizzes };
  });
  assert.ok(topics.reduce((a, t) => a + t.quizzes.length * 4, 0) >= MIN_ANSWERS_TO_FIT);
  const r = fitUserParams(topics, 9000);
  assert.ok(r.lossFitted < r.lossDefault, `${r.lossFitted} < ${r.lossDefault}`);
  assert.ok(r.params.userPrior > 1.3, `userPrior ${r.params.userPrior}`);
});
