// Background processing of uploaded PDFs: extract → split → topics, notes, formulas, questions.
import fs from 'node:fs';
import path from 'node:path';
import db from './db.ts';
import { UPLOAD_DIR } from './config.ts';
import { extractPdf } from './pdf.ts';
import { generateTopics, type GenTopic } from './content.ts';
import { ocrPages } from './ocr.ts';
import { processPastPaper } from './pastPapers.ts';

const setStatus = (id: number, status: string, progress: number, error: string | null = null) =>
  db.prepare('UPDATE sources SET status=?, progress=?, error=? WHERE id=?').run(status, progress, error, id);

export function saveGenerated(subjectId: number, sourceId: number | null, topics: GenTopic[]) {
  const startIdx = (db.prepare('SELECT COALESCE(MAX(order_idx),-1)+1 n FROM topics WHERE subject_id=?').get(subjectId) as { n: number }).n;
  const insTopic = db.prepare(`INSERT INTO topics(subject_id,source_id,title,chapter,order_idx,difficulty,weight,weight_source,est_learn_min,page_from,page_to,note_line,note_compact,note_detailed,note_simple)
    VALUES(?,?,?,?,?,?,?,'ai_estimate',?,?,?,?,?,?,?)`);
  const insItem = db.prepare('INSERT INTO items(topic_id,kind,name,latex,meaning) VALUES(?,?,?,?,?)');
  const insQ = db.prepare('INSERT INTO questions(topic_id,item_id,type,prompt,options_json,answer_idx,explanation,page_ref) VALUES(?,?,?,?,?,?,?,?)');
  const insD = db.prepare('INSERT OR IGNORE INTO distractors(question_id,option_idx,topic_id) VALUES(?,?,?)');

  db.transaction(() => {
    const idByTitle = new Map<string, number>();
    const pending: { qid: number; tags: (string | null)[] }[] = [];
    topics.forEach((t, i) => {
      const tid = Number(insTopic.run(subjectId, sourceId, t.title, t.chapter, startIdx + i, t.difficulty, t.importance, t.estLearnMin,
        t.pageFrom, t.pageTo, t.line, t.compact, t.detailed, t.simple).lastInsertRowid);
      idByTitle.set(t.title.toLowerCase(), tid);
      const itemIds = new Map<string, number>();
      for (const f of t.formulas) itemIds.set(f.name, Number(insItem.run(tid, 'formula', f.name, f.latex, f.meaning ?? null).lastInsertRowid));
      for (const q of t.questions) {
        const qid = Number(insQ.run(tid, q.formulaName ? itemIds.get(q.formulaName) ?? null : null, 'mcq', q.prompt,
          JSON.stringify(q.options), q.answer, q.explanation ?? null, q.page ?? null).lastInsertRowid);
        if (q.distractorTopics) pending.push({ qid, tags: q.distractorTopics });
      }
    });
    // Also match existing topics in this subject (e.g. from another PDF).
    for (const r of db.prepare('SELECT id,title FROM topics WHERE subject_id=?').all(subjectId) as { id: number; title: string }[])
      if (!idByTitle.has(r.title.toLowerCase())) idByTitle.set(r.title.toLowerCase(), r.id);
    for (const p of pending) p.tags.forEach((tag, idx) => {
      const tid = tag ? idByTitle.get(tag.toLowerCase()) : undefined;
      if (tid) insD.run(p.qid, idx, tid);
    });
  })();
}

async function processSource(id: number) {
  const src = db.prepare('SELECT * FROM sources WHERE id=?').get(id) as { id: number; subject_id: number; title: string; file_name: string; kind: string };
  setStatus(id, 'processing', 0.02);
  try {
    const data = new Uint8Array(fs.readFileSync(path.join(UPLOAD_DIR, src.file_name)));
    const pdf = await extractPdf(data, f => setStatus(id, 'processing', 0.02 + f * 0.13));
    db.prepare('UPDATE sources SET pages=? WHERE id=?').run(pdf.pages.length, id);

    // Scanned pages have (almost) no text layer: read them with OCR.
    const scanned = pdf.pages.map((t, i) => (t.replace(/\s/g, '').length < 50 ? i + 1 : 0)).filter(Boolean);
    if (scanned.length) {
      const texts = await ocrPages(data, scanned, f => setStatus(id, 'processing', 0.15 + f * 0.35));
      for (const [n, t] of texts) pdf.pages[n - 1] = t;
      db.prepare('UPDATE sources SET ocr_pages=? WHERE id=?').run(scanned.length, id);
    }
    const textChars = pdf.pages.join('').replace(/\s/g, '').length;
    if (textChars < 200) throw new Error('Could not read any text from this PDF, even with OCR. Try a clearer scan.');

    if (src.kind === 'past_paper') {
      setStatus(id, 'processing', 0.6);
      await processPastPaper(id, src.subject_id, src.title, pdf.pages);
    } else {
      const topics = await generateTopics(pdf, src.title, f => setStatus(id, 'processing', 0.5 + f * 0.45));
      if (!topics.length) throw new Error('Could not find any topics in this PDF.');
      saveGenerated(src.subject_id, id, topics);
    }
    setStatus(id, 'done', 1);
  } catch (e) {
    console.error('[JOB] source', id, (e as Error).message);
    setStatus(id, 'failed', 0, (e as Error).message);
  }
}

let running = false;
export function startWorker() {
  db.prepare("UPDATE sources SET status='queued' WHERE status='processing'").run(); // resume after restart
  setInterval(async () => {
    if (running) return;
    const next = db.prepare("SELECT id FROM sources WHERE status='queued' ORDER BY id LIMIT 1").get() as { id: number } | undefined;
    if (!next) return;
    running = true;
    try { await processSource(next.id); } finally { running = false; }
  }, 1000);
}
