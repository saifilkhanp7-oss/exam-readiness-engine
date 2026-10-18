// Recording answers and updating memory after a quiz. Shared by the online quiz and offline sync.
import db from './db.ts';
import { updateAfterQuiz, startState } from '@ere/engine';
import { paramsFor, saveItemState, saveTopicState, stateOf, type ItemRow, type TopicRow } from './store.ts';

export interface AnswerInput { questionId: unknown; chosenIdx: unknown; confidence: unknown; responseMs: unknown; quizId?: unknown; answeredAt?: unknown }

export function recordAnswer(userId: number, a: AnswerInput) {
  const q = db.prepare(`SELECT q.*, s.user_id FROM questions q JOIN topics t ON t.id=q.topic_id JOIN subjects s ON s.id=t.subject_id WHERE q.id=?`).get(Number(a.questionId)) as any;
  if (!q || q.user_id !== userId) return null;
  const conf = Math.min(5, Math.max(1, Number(a.confidence) || 3));
  const chosen = Number(a.chosenIdx);
  const correct = chosen === q.answer_idx;
  // Offline answers keep the time they were really given (but never in the future).
  const at = Math.min(Date.now(), Number(a.answeredAt) || Date.now());
  db.prepare('INSERT INTO attempts(user_id,question_id,topic_id,confidence,chosen_idx,correct,response_ms,answered_at,quiz_id) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(userId, q.id, q.topic_id, conf, chosen, correct ? 1 : 0, Math.max(0, Number(a.responseMs) || 0), at, String(a.quizId || ''));

  // Confusion tracking: one exposure per question per other topic; picking that topic's option is a mix-up.
  const ds = db.prepare('SELECT option_idx, topic_id FROM distractors WHERE question_id=?').all(q.id) as { option_idx: number; topic_id: number }[];
  let confusedWith: string | null = null;
  for (const tid of new Set(ds.filter(d => d.topic_id !== q.topic_id).map(d => d.topic_id))) {
    const hit = !correct && ds.some(d => d.topic_id === tid && d.option_idx === chosen) ? 1 : 0;
    db.prepare(`INSERT INTO confusions(user_id,topic_a,topic_b,count,exposures,last_at) VALUES(?,?,?,?,1,?)
      ON CONFLICT(user_id,topic_a,topic_b) DO UPDATE SET count=count+excluded.count, exposures=exposures+1, last_at=excluded.last_at`)
      .run(userId, q.topic_id, tid, hit, at);
    if (hit) confusedWith = (db.prepare('SELECT title FROM topics WHERE id=?').get(tid) as { title: string }).title;
  }
  return { correct, answerIdx: q.answer_idx as number, explanation: q.explanation as string | null, confusedWith };
}

export function finishQuiz(user: { id: number; target_recall: number }, quizId: string, _tz = 'UTC') {
  const rows = db.prepare(`SELECT a.*, q.item_id FROM attempts a LEFT JOIN questions q ON q.id=a.question_id WHERE a.user_id=? AND a.quiz_id=?`).all(user.id, quizId) as any[];
  if (!rows.length) return null;
  const xs = (db.prepare('SELECT response_ms FROM attempts WHERE user_id=? ORDER BY id DESC LIMIT 200').all(user.id) as any[]).map(r => r.response_ms).sort((a, b) => a - b);
  const median = xs[xs.length >> 1] || 10000;
  const at = Math.max(...rows.map(r => r.answered_at));
  const p = paramsFor(user);
  const results: any[] = [];
  const byTopic = new Map<number, any[]>();
  for (const r of rows) byTopic.set(r.topic_id, [...(byTopic.get(r.topic_id) ?? []), r]);
  for (const [tid, list] of byTopic) {
    const t = db.prepare('SELECT * FROM topics WHERE id=?').get(tid) as TopicRow;
    const before = stateOf(t, t.difficulty);
    const answers = (l: any[]) => l.map(r => ({ correct: Boolean(r.correct), confidence: r.confidence, responseMs: r.response_ms }));
    // Personal model: a new topic starts from this student's own starting strength.
    const start = t.last_review_at == null ? startState(t.difficulty, p) : before;
    const after = updateAfterQuiz(start, answers(list), at, t.difficulty, median, p);
    saveTopicState(tid, after);
    // Formulas get their own curves.
    const byItem = new Map<number, any[]>();
    for (const r of list) if (r.item_id) byItem.set(r.item_id, [...(byItem.get(r.item_id) ?? []), r]);
    for (const [iid, il] of byItem) {
      const it = db.prepare('SELECT * FROM items WHERE id=?').get(iid) as ItemRow;
      const ist = it.last_review_at == null && t.last_review_at != null ? before : stateOf(it, t.difficulty);
      saveItemState(iid, updateAfterQuiz(ist, answers(il), at, t.difficulty, median, p));
    }
    results.push({
      topicId: tid, title: t.title, correct: list.filter(r => r.correct).length, total: list.length,
      halfLifeBefore: t.last_review_at == null ? null : before.halfLife, halfLifeAfter: after.halfLife,
      avgConfidence: list.reduce((a, r) => a + r.confidence, 0) / list.length,
    });
  }
  return results;
}
