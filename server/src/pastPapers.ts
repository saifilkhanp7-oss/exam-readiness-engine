// Past papers: split a paper into questions (with marks and year), match each to a topic,
// then weight topics by how many marks they got: weight ∝ Σ marks × 0.85^(years ago).
import db from './db.ts';
import { aiEnabled, mapQuestionsWithAI } from './ai.ts';

export interface PaperQuestion { number: string; text: string; marks: number }

const Q_START = /^\s*(?:Q(?:uestion)?\.?\s*)?(\d{1,2})\s*[.):]\s*(.*)$/i;
const MARKS = [
  /\[\s*(\d{1,2})\s*(?:marks?|m)?\s*\]/i,
  /\(\s*(\d{1,2})\s*marks?\s*\)/i,
  /\b(\d{1,2})\s*marks?\b/i,
];

export function findYear(...texts: string[]): number | null {
  const now = new Date().getFullYear();
  for (const t of texts) {
    const years = [...t.matchAll(/\b((?:19|20)\d{2})\b/g)].map(m => Number(m[1])).filter(y => y >= 1990 && y <= now);
    if (years.length) return Math.max(...years);
  }
  return null;
}

/** Split paper text into numbered questions. Sub-parts like (a), (b) stay with their question. */
export function splitQuestions(text: string): PaperQuestion[] {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const qs: PaperQuestion[] = [];
  let cur: PaperQuestion | null = null;
  let expected = 1;
  for (const l of lines) {
    const m = l.match(Q_START);
    // Accept a new number only if it is the next one (or close), so "3 marks" lines don't start questions.
    if (m && Number(m[1]) >= expected && Number(m[1]) <= expected + 2 && m[2].length >= 3) {
      if (cur) qs.push(cur);
      cur = { number: m[1], text: m[2], marks: 0 };
      expected = Number(m[1]) + 1;
      continue;
    }
    if (cur) cur.text += ' ' + l;
  }
  if (cur) qs.push(cur);
  for (const q of qs) {
    // Sum marks of sub-parts if present, else the single mark label.
    const parts = [...q.text.matchAll(/\[\s*(\d{1,2})\s*(?:marks?|m)?\s*\]|\(\s*(\d{1,2})\s*marks?\s*\)/gi)].map(m => Number(m[1] ?? m[2]));
    if (parts.length > 1) q.marks = parts.reduce((a, b) => a + b, 0);
    else for (const re of MARKS) { const mm = q.text.match(re); if (mm) { q.marks = Number(mm[1]); break; } }
    q.text = q.text.replace(/\s+/g, ' ').trim();
  }
  const anyMarks = qs.some(q => q.marks > 0);
  for (const q of qs) if (!q.marks) q.marks = anyMarks ? Math.max(1, Math.round(qs.reduce((a, x) => a + x.marks, 0) / qs.filter(x => x.marks).length)) : 1;
  return qs.filter(q => q.text.length >= 12);
}

// ---------- matching questions to topics (TF-IDF cosine) ----------

const STOP = new Set('the and for are with that this from what which how why when where explain describe state give define calculate find show write draw marks mark question answer each following briefly between using their they them into its has have was were been does any all two one three can also your you about used use name list short notes note'.split(' '));
const tokens = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(w => w.length >= 3 && !STOP.has(w)).map(w => w.replace(/(ies)$/, 'y').replace(/(es|s)$/, ''));

interface TopicDoc { id: number; title: string; text: string }

export function matchToTopics(questions: PaperQuestion[], topics: TopicDoc[]): { topicId: number | null; score: number }[] {
  const docs = topics.map(t => {
    const tf = new Map<string, number>();
    const add = (s: string, w: number) => { for (const tok of tokens(s)) tf.set(tok, (tf.get(tok) ?? 0) + w); };
    add(t.title, 4); add(t.text, 1);
    return { id: t.id, tf };
  });
  const df = new Map<string, number>();
  for (const d of docs) for (const k of d.tf.keys()) df.set(k, (df.get(k) ?? 0) + 1);
  const idf = (k: string) => Math.log((docs.length + 1) / ((df.get(k) ?? 0) + 1)) + 1;
  const vec = (tf: Map<string, number>) => {
    const v = new Map<string, number>();
    let norm = 0;
    for (const [k, c] of tf) { const x = (1 + Math.log(c)) * idf(k); v.set(k, x); norm += x * x; }
    return { v, norm: Math.sqrt(norm) || 1 };
  };
  const dvecs = docs.map(d => ({ id: d.id, ...vec(d.tf) }));
  return questions.map(q => {
    const tf = new Map<string, number>();
    for (const tok of tokens(q.text)) tf.set(tok, (tf.get(tok) ?? 0) + 1);
    const qv = vec(tf);
    let best = { topicId: null as number | null, score: 0 };
    for (const d of dvecs) {
      let dot = 0;
      for (const [k, x] of qv.v) { const y = d.v.get(k); if (y) dot += x * y; }
      const s = dot / (qv.norm * d.norm);
      if (s > best.score) best = { topicId: d.id, score: s };
    }
    return best.score >= 0.06 ? best : { topicId: null, score: best.score };
  });
}

/** Process a past-paper source: split, match, store, then reweight the subject. */
export async function processPastPaper(sourceId: number, subjectId: number, title: string, pages: string[]) {
  const text = pages.join('\n');
  const year = findYear(title, pages[0] ?? '', text.slice(0, 3000));
  const questions = splitQuestions(text);
  if (!questions.length) throw new Error('Could not find numbered questions in this paper (expected "1.", "Q1" or "Question 1").');
  const topics = (db.prepare('SELECT id, title, chapter, note_line, note_compact, note_detailed FROM topics WHERE subject_id=?').all(subjectId) as any[])
    .map(t => ({ id: t.id, title: t.title, text: [t.chapter, t.note_line, t.note_compact, t.note_detailed].filter(Boolean).join(' ') }));
  if (!topics.length) throw new Error('Add topics or upload the book first, so questions can be matched to topics.');

  let matches = matchToTopics(questions, topics);
  if (aiEnabled()) {
    try {
      const ai = await mapQuestionsWithAI(questions.map(q => q.text), topics.map(t => t.title));
      matches = ai.map((idx, i) => (idx == null ? matches[i] : { topicId: topics[idx].id, score: 1 }));
    } catch (e) { console.warn('[PAPER] AI matching failed, using keyword matching:', (e as Error).message); }
  }

  db.transaction(() => {
    db.prepare('DELETE FROM paper_questions WHERE source_id=?').run(sourceId);
    const ins = db.prepare('INSERT INTO paper_questions(source_id,subject_id,number,text,marks,year,topic_id,match_score) VALUES(?,?,?,?,?,?,?,?)');
    questions.forEach((q, i) => ins.run(sourceId, subjectId, q.number, q.text.slice(0, 2000), q.marks, year, matches[i].topicId, matches[i].score));
    db.prepare('UPDATE sources SET year=? WHERE id=?').run(year, sourceId);
  })();
  reweightFromPapers(subjectId);
  return { questions: questions.length, matched: matches.filter(m => m.topicId).length, year };
}

/** weight_i ∝ Σ marks × 0.85^(years ago). Topics never asked keep a small weight; manual weights are left alone. */
export function reweightFromPapers(subjectId: number) {
  const now = new Date().getFullYear();
  const rows = db.prepare('SELECT topic_id, marks, year FROM paper_questions WHERE subject_id=? AND topic_id IS NOT NULL').all(subjectId) as { topic_id: number; marks: number; year: number | null }[];
  const topics = db.prepare("SELECT id, weight, weight_source FROM topics WHERE subject_id=?").all(subjectId) as { id: number; weight: number; weight_source: string }[];
  if (!rows.length) {
    // No papers left: fall back to the content estimate for topics that were weighted by papers.
    db.prepare("UPDATE topics SET weight_source='ai_estimate' WHERE subject_id=? AND weight_source='past_papers'").run(subjectId);
    return;
  }
  const score = new Map<number, number>();
  for (const r of rows) score.set(r.topic_id, (score.get(r.topic_id) ?? 0) + r.marks * Math.pow(0.85, Math.max(0, now - (r.year ?? now - 2))));
  const auto = topics.filter(t => t.weight_source !== 'manual');
  const total = [...score.values()].reduce((a, b) => a + b, 0);
  const avg = total / Math.max(1, auto.length);
  const up = db.prepare("UPDATE topics SET weight=?, weight_source='past_papers' WHERE id=?");
  db.transaction(() => {
    for (const t of auto) {
      const s = score.get(t.id) ?? 0;
      // Scale to "marks out of 100" so it sits next to manual weights sensibly.
      const w = (Math.max(s, avg * 0.15) / Math.max(total, 1e-9)) * 100;
      up.run(Math.round(w * 100) / 100, t.id);
    }
  })();
}

export function paperStats(subjectId: number) {
  const byTopic = db.prepare(`SELECT topic_id, COUNT(*) n, SUM(marks) marks FROM paper_questions WHERE subject_id=? AND topic_id IS NOT NULL GROUP BY topic_id`).all(subjectId) as { topic_id: number; n: number; marks: number }[];
  const papers = db.prepare(`SELECT s.id, s.title, s.year, s.status, s.error, COUNT(q.id) questions, SUM(q.topic_id IS NOT NULL) matched
    FROM sources s LEFT JOIN paper_questions q ON q.source_id=s.id WHERE s.subject_id=? AND s.kind='past_paper' GROUP BY s.id ORDER BY s.year DESC, s.id DESC`).all(subjectId);
  const unmatched = db.prepare('SELECT id, number, text, marks, year FROM paper_questions WHERE subject_id=? AND topic_id IS NULL LIMIT 20').all(subjectId);
  return { byTopic: new Map(byTopic.map(r => [r.topic_id, r])), papers, unmatched };
}
