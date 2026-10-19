// Background processing of uploaded PDFs: extract → split → topics, notes, formulas, questions.
import fs from 'node:fs';
import path from 'node:path';
import db from './db.ts';
import { UPLOAD_DIR } from './config.ts';
import { extractPdf } from './pdf.ts';
import { aiFailureReason, generateTopics, generateTopicsFromPages, type GenTopic } from './content.ts';
import { AiDailyLimitError, aiEnabled, aiName } from './ai.ts';
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

    const setNote = (note: string) => db.prepare('UPDATE sources SET note=? WHERE id=?').run(note, id);
    // Scanned, photographed or handwritten pages have (almost) no text layer.
    const scanned = pdf.pages.map((t, i) => (t.replace(/\s/g, '').length < 50 ? i + 1 : 0)).filter(Boolean);
    const mostlyImages = scanned.length >= Math.max(1, pdf.pages.length * 0.5);

    // Best path for handwriting: Claude reads the page images itself. Tesseract only reads printed text.
    if (mostlyImages && aiEnabled() && src.kind !== 'past_paper') {
      try {
        setStatus(id, 'processing', 0.15);
        const topics = await generateTopicsFromPages(data, pdf.pages.length, src.title, f => setStatus(id, 'processing', 0.15 + f * 0.8));
        if (!topics.length) throw new Error('no topics');
        db.prepare('UPDATE sources SET ocr_pages=? WHERE id=?').run(scanned.length, id);
        saveGenerated(src.subject_id, id, topics);
        setNote(`Read from the page images by ${aiName()} (handwritten or scanned pages).`);
        setStatus(id, 'done', 1);
        return;
      } catch (e) {
        if (e instanceof AiDailyLimitError) throw e;
        console.warn('[AI] page-image reading failed, trying OCR:', (e as Error).message);
        setNote(`${aiName()} could not read the pages because ${aiFailureReason(e)}, so the offline reader was used. It only reads printed text, so handwriting may come out wrong. Upload again later.`);
      }
    }

    let ocrConfidence = 100;
    if (scanned.length) {
      const { texts, confidence } = await ocrPages(data, scanned, f => setStatus(id, 'processing', 0.15 + f * 0.35));
      for (const [n, t] of texts) pdf.pages[n - 1] = t;
      ocrConfidence = confidence;
      db.prepare('UPDATE sources SET ocr_pages=? WHERE id=?').run(scanned.length, id);
    }
    const handwritingHint = 'If these are handwritten notes: the offline reader can only read printed text. Add a free Gemini API key (or Claude credits) and upload again, and the AI will read the handwriting.';
    const textChars = pdf.pages.join('').replace(/\s/g, '').length;
    if (textChars < 200) throw new Error(`Could not read any text from this PDF. ${handwritingHint}`);
    if (scanned.length) console.log(`[OCR] source ${id}: ${scanned.length} pages, confidence ${ocrConfidence.toFixed(0)}`);
    // Very unsure reading of mostly-image pages is almost always handwriting: junk topics are worse than none.
    if (mostlyImages && ocrConfidence < 50 && src.kind !== 'past_paper') throw new Error(`These pages look handwritten, and the offline reader cannot read handwriting. ${aiEnabled() ? `${aiName()} could not be used just now, so please upload again later.` : 'Add a free Gemini API key (or Claude credits) and upload again, and the AI will read the handwriting.'}`);
    if (mostlyImages && ocrConfidence < 65 && !aiEnabled()) setNote(`Much of the text could not be read clearly, so these notes may have mistakes. ${handwritingHint}`);

    if (src.kind === 'past_paper') {
      setStatus(id, 'processing', 0.6);
      await processPastPaper(id, src.subject_id, src.title, pdf.pages);
    } else {
      const topics = await generateTopics(pdf, src.title, f => setStatus(id, 'processing', 0.5 + f * 0.45),
        setNote, data);
      if (!topics.length) throw new Error(mostlyImages ? `Could not find any topics in this PDF. ${handwritingHint}` : 'Could not find any topics in this PDF.');
      saveGenerated(src.subject_id, id, topics);
    }
    setStatus(id, 'done', 1);
    db.prepare('UPDATE sources SET retry_after=NULL WHERE id=?').run(id);
  } catch (e) {
    if (e instanceof AiDailyLimitError) {
      // Free daily quota used up: wait for the reset (midnight US Pacific) and carry on by itself.
      const at = nextPacificMidnight() + 5 * 60_000;
      db.prepare("UPDATE sources SET status='queued', progress=0, retry_after=?, note=? WHERE id=?")
        .run(at, "Gemini's free daily limit is used up. This file will carry on by itself after the limit resets.", id);
      console.warn('[JOB] source', id, 'waiting for Gemini daily reset until', new Date(at).toISOString());
      return;
    }
    console.error('[JOB] source', id, (e as Error).message);
    setStatus(id, 'failed', 0, (e as Error).message);
  }
}

/** Gemini's daily quota resets at midnight US Pacific time. */
function nextPacificMidnight(now = Date.now()): number {
  const d = new Date(now);
  const la = new Date(d.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
  const utc = new Date(d.toLocaleString('en-US', { timeZone: 'UTC' }));
  const offset = la.getTime() - utc.getTime();            // Pacific minus UTC, e.g. -7 h
  const day = 86_400_000;
  return (Math.floor((now + offset) / day) + 1) * day - offset;
}

let running = false;
export function startWorker() {
  db.prepare("UPDATE sources SET status='queued' WHERE status='processing'").run(); // resume after restart
  setInterval(async () => {
    if (running) return;
    const next = db.prepare("SELECT id FROM sources WHERE status='queued' AND (retry_after IS NULL OR retry_after<=?) ORDER BY id LIMIT 1").get(Date.now()) as { id: number } | undefined;
    if (!next) return;
    running = true;
    try { await processSource(next.id); } finally { running = false; }
  }, 1000);
}
