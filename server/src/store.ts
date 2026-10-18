// Loads rows into engine shapes and saves memory states back.
import db from './db.ts';
import {
  DEFAULT_PARAMS, initialState, type MemoryState, type SubjectInput, type UserParams,
} from '@ere/engine';

export interface TopicRow {
  id: number; subject_id: number; source_id: number | null; title: string; chapter: string | null; order_idx: number;
  difficulty: number; weight: number; weight_source: string; est_learn_min: number;
  page_from: number | null; page_to: number | null;
  note_line: string | null; note_compact: string | null; note_detailed: string | null; note_simple: string | null;
  half_life: number | null; mastery: number; last_review_at: number | null; n_reviews: number; hl_unc: number; skip: number;
}
export interface SubjectRow { id: number; user_id: number; name: string; color: string; exam_at: number; total_marks: number; guess_rate: number; created_at: number }
export interface ItemRow { id: number; topic_id: number; kind: string; name: string; latex: string | null; meaning: string | null; half_life: number | null; mastery: number; last_review_at: number | null; n_reviews: number; hl_unc: number }

/** The student's memory parameters: personal ones once fitted (see personalModel.ts), otherwise the defaults. */
export function paramsFor(user: { id: number; target_recall: number }): UserParams & { contextMult: Record<string, number> } {
  const row = db.prepare('SELECT params_json FROM user_params WHERE user_id=?').get(user.id) as { params_json: string } | undefined;
  const fitted = row ? JSON.parse(row.params_json) : {};
  return { ...DEFAULT_PARAMS, contextMult: {}, ...fitted, targetRecall: user.target_recall };
}

export function stateOf(r: { half_life: number | null; mastery: number; last_review_at: number | null; n_reviews: number; hl_unc: number }, difficulty: number): MemoryState {
  const base = initialState(difficulty);
  return {
    halfLife: r.half_life ?? base.halfLife,
    mastery: r.mastery,
    lastReviewAt: r.last_review_at,
    nReviews: r.n_reviews,
    hlUncertainty: r.hl_unc,
  };
}

export function saveTopicState(id: number, s: MemoryState) {
  db.prepare('UPDATE topics SET half_life=?, mastery=?, last_review_at=?, n_reviews=?, hl_unc=? WHERE id=?')
    .run(s.halfLife, s.mastery, s.lastReviewAt, s.nReviews, s.hlUncertainty, id);
}
export function saveItemState(id: number, s: MemoryState) {
  db.prepare('UPDATE items SET half_life=?, mastery=?, last_review_at=?, n_reviews=?, hl_unc=? WHERE id=?')
    .run(s.halfLife, s.mastery, s.lastReviewAt, s.nReviews, s.hlUncertainty, id);
}

export const subjectsOf = (userId: number) =>
  db.prepare('SELECT * FROM subjects WHERE user_id=? ORDER BY exam_at').all(userId) as SubjectRow[];

export const topicsOf = (subjectId: number) =>
  db.prepare('SELECT * FROM topics WHERE subject_id=? ORDER BY order_idx, id').all(subjectId) as TopicRow[];

export function ownSubject(userId: number, subjectId: number) {
  return db.prepare('SELECT * FROM subjects WHERE id=? AND user_id=?').get(subjectId, userId) as SubjectRow | undefined;
}
export function ownTopic(userId: number, topicId: number) {
  return db.prepare('SELECT t.* FROM topics t JOIN subjects s ON s.id=t.subject_id WHERE t.id=? AND s.user_id=?').get(topicId, userId) as TopicRow | undefined;
}

export function toSubjectInput(s: SubjectRow, topics = topicsOf(s.id)): SubjectInput {
  return {
    id: s.id, name: s.name, examAt: s.exam_at, totalMarks: s.total_marks, guessRate: s.guess_rate,
    topics: topics.map(t => ({
      id: t.id, title: t.title, weight: t.weight, difficulty: t.difficulty, estLearnMin: t.est_learn_min,
      state: stateOf(t, t.difficulty), skip: Boolean(t.skip),
    })),
  };
}

export function engineInputs(userId: number, now = Date.now()) {
  return subjectsOf(userId).filter(s => s.exam_at > now).map(s => toSubjectInput(s));
}
