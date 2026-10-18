// Turns extracted book text into topics, notes (3 levels), formulas and quiz questions.
// Uses Claude when ANTHROPIC_API_KEY is set; otherwise a heuristic fallback so the app runs without a key.
import type { PdfText } from './pdf.ts';
import { aiEnabled, generateChapterWithAI } from './ai.ts';

export interface GenFormula { name: string; latex: string; meaning?: string }
export interface GenQuestion {
  prompt: string;
  options: string[];
  answer: number;
  explanation?: string;
  distractorTopics?: (string | null)[];  // which topic each option really belongs to (null = none)
  formulaName?: string;
  page?: number;
}
export interface GenTopic {
  title: string;
  chapter: string;
  difficulty: number;
  importance: number;      // relative weight
  estLearnMin: number;
  pageFrom: number;
  pageTo: number;
  line: string;            // one-line note
  compact: string;         // markdown bullets
  detailed: string;        // markdown
  simple: string;          // simplified explanation
  formulas: GenFormula[];
  questions: GenQuestion[];
}

interface Section { title: string; chapter: string; pageFrom: number; pageTo: number; text: string }

const CHAPTER_RE = /^(chapter|unit|part)\s+(\d+|[ivxlc]+)\b[.:\-\s]*(.*)$/i;
const SECTION_RE = /^(\d{1,2}(?:\.\d{1,2}){1,2})\s+([A-Z][^.!?]{2,70})$/;

/** Split the book into chapters and sections, using the PDF outline first, then heading patterns. */
export function splitSections(pdf: PdfText, fallbackTitle: string): Section[] {
  const lines: { text: string; page: number }[] = [];
  pdf.pages.forEach((p, i) => p.split('\n').forEach(l => { const t = l.trim(); if (t) lines.push({ text: t, page: i + 1 }); }));

  type Mark = { idx: number; title: string; level: 1 | 2 };
  const marks: Mark[] = [];
  lines.forEach((l, idx) => {
    if (l.text.length > 80) return;
    const c = l.text.match(CHAPTER_RE);
    if (c) { marks.push({ idx, title: l.text.replace(/\s+/g, ' '), level: 1 }); return; }
    const s = l.text.match(SECTION_RE);
    if (s) marks.push({ idx, title: `${s[1]} ${s[2].trim()}`, level: 2 });
  });

  // Prefer the PDF outline when the text has no clear headings.
  if (marks.length < 2 && pdf.outline.length >= 2) {
    for (const o of pdf.outline) {
      const idx = lines.findIndex(l => l.page >= o.page);
      if (idx >= 0) marks.push({ idx, title: o.title, level: o.level === 1 ? 1 : 2 });
    }
    marks.sort((a, b) => a.idx - b.idx);
  }

  const sections: Section[] = [];
  if (!marks.length) {
    // No structure at all: one topic per ~6 pages.
    const per = 6;
    for (let start = 0; start < pdf.pages.length; start += per) {
      const text = pdf.pages.slice(start, start + per).join('\n');
      if (text.trim().length < 200) continue;
      const first = text.split('\n').find(l => l.trim().length > 3 && l.trim().length < 70) ?? `Part ${start / per + 1}`;
      sections.push({ title: first.trim(), chapter: fallbackTitle, pageFrom: start + 1, pageTo: Math.min(pdf.pages.length, start + per), text });
    }
    return sections;
  }

  let chapter = fallbackTitle;
  for (let m = 0; m < marks.length; m++) {
    const mk = marks[m];
    const end = m + 1 < marks.length ? marks[m + 1].idx : lines.length;
    const body = lines.slice(mk.idx + 1, end);
    if (mk.level === 1) {
      chapter = mk.title;
      // Chapter with its own text but no sections → becomes a topic itself.
      const nextIsSection = marks[m + 1]?.level === 2;
      if (nextIsSection && body.map(b => b.text).join(' ').length < 400) continue;
    }
    const text = body.map(b => b.text).join('\n');
    if (text.length < 80) continue;
    sections.push({
      title: mk.title.replace(CHAPTER_RE, (_, a, b, rest) => rest || `${a} ${b}`).replace(/^\d+(\.\d+)*\s+/, ''),
      chapter,
      pageFrom: lines[mk.idx].page,
      pageTo: body.length ? body[body.length - 1].page : lines[mk.idx].page,
      text,
    });
  }
  return sections;
}

// ---------- heuristic fallback ----------

const sentencesOf = (text: string) =>
  text.replace(/\n(?=[a-z(])/g, ' ').replace(/-\n/g, '').replace(/\n/g, ' ')
    .split(/(?<=[.!?])\s+(?=[A-Z(])/).map(s => s.trim()).filter(s => s.length > 25 && s.length < 320);

const isFormulaLine = (l: string) => {
  const t = l.trim();
  return t.includes('=') && t.length >= 3 && t.length <= 70 && /[A-Za-zΔΣπθλμρ]/.test(t) && t.split(/\s+/).length <= 12 && !/[.?!]$/.test(t);
};

const DEF_RE = /^(?:The |An |A )?([A-Z][A-Za-z\- ']{2,40}?)\s+(is|are|refers to|means)\s+(.{10,})$/;

function scoreSentence(s: string, i: number) {
  let sc = 0;
  if (DEF_RE.test(s)) sc += 3;
  if (/\b(law|principle|defined|called|known as|important|key|always|never|states that)\b/i.test(s)) sc += 2;
  if (/\d/.test(s)) sc += 1;
  if (i === 0) sc += 1.5;
  if (s.length > 220) sc -= 1;
  return sc;
}

const shorten = (s: string, n = 150) => s.length <= n ? s : s.slice(0, s.lastIndexOf(' ', n)) + '…';

function heuristicTopic(sec: Section): Omit<GenTopic, 'questions'> & { defs: { term: string; rest: string }[] } {
  const sents = sentencesOf(sec.text.split('\n').filter(l => !isFormulaLine(l)).join('\n'));
  const scored = sents.map((s, i) => ({ s, i, sc: scoreSentence(s, i) }));
  const top = [...scored].sort((a, b) => b.sc - a.sc);
  const compactSel = top.slice(0, 5).sort((a, b) => a.i - b.i).map(x => x.s);
  const detailedSel = top.slice(0, 12).sort((a, b) => a.i - b.i).map(x => x.s);
  const formulas: GenFormula[] = [];
  for (const l of sec.text.split('\n')) if (isFormulaLine(l) && formulas.length < 6) {
    const lhs = l.split('=')[0].trim();
    formulas.push({ name: /^[A-Za-zΔΣπθλμρ_0-9 ]{1,6}$/.test(lhs) ? lhs : `${sec.title} equation${formulas.length ? ` ${formulas.length + 1}` : ''}`, latex: l.trim() });
  }
  const BAD_START = /^(During|In|At|When|It|This|These|There|Each|About|After|Before|Its|Their|Both)\b/;
  const defs = sents.map(s => s.match(DEF_RE)).filter(Boolean)
    .map(m => ({ term: m![1].trim(), rest: `${m![2]} ${m![3]}` }))
    .filter(d => d.term.split(' ').length <= 4 && !BAD_START.test(d.term));
  const words = sec.text.split(/\s+/).length;
  const avgLen = sents.length ? sents.reduce((a, s) => a + s.split(' ').length, 0) / sents.length : 15;
  const difficulty = Math.min(0.85, Math.max(0.25, 0.25 + (avgLen - 12) / 40 + formulas.length * 0.05));
  const line = defs[0] ? shorten(`${defs[0].term} ${defs[0].rest}`) : shorten(compactSel[0] ?? sec.title);
  return {
    title: sec.title, chapter: sec.chapter, difficulty, importance: Math.max(1, Math.round(words / 150)),
    estLearnMin: Math.min(180, Math.max(15, Math.round((words / 250) * 10 * (0.7 + difficulty)))),
    pageFrom: sec.pageFrom, pageTo: sec.pageTo,
    line,
    compact: compactSel.map(s => `- ${shorten(s, 200)}`).join('\n'),
    detailed: detailedSel.map(s => `- ${s}`).join('\n') + (formulas.length ? `\n\n**Formulas**\n${formulas.map(f => `- \`${f.latex}\``).join('\n')}` : ''),
    simple: compactSel.slice(0, 4).map(s => shorten(s, 180)).join(' '),
    formulas, defs,
  };
}

function shuffleWithAnswer<T>(correct: T, others: T[], seed: number) {
  const all = [correct, ...others];
  let x = (seed * 2654435761) >>> 0 || 1;
  const rand = () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; };
  const order = all.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
  return { options: order.map(i => all[i]), answer: order.indexOf(0), order };
}

function heuristicQuestions(topics: ReturnType<typeof heuristicTopic>[]): GenQuestion[][] {
  return topics.map((t, ti) => {
    const qs: GenQuestion[] = [];
    const others = topics.filter((_, j) => j !== ti);
    t.defs.slice(0, 5).forEach((d, k) => {
      const pool = others.flatMap(o => o.defs.map(od => ({ term: od.term, topic: o.title }))).filter(x => x.term.toLowerCase() !== d.term.toLowerCase());
      const uniq = [...new Map(pool.map(p => [p.term.toLowerCase(), p])).values()].slice(k, k + 3);
      if (uniq.length < 2) return;
      const { options, answer, order } = shuffleWithAnswer(d.term, uniq.map(u => u.term), ti * 31 + k);
      const tagged = [null, ...uniq.map(u => u.topic)];
      qs.push({
        prompt: `Which term matches: "… ${shorten(d.rest, 170)}"`,
        options, answer,
        distractorTopics: order.map(i => tagged[i]),
        explanation: `${d.term} ${shorten(d.rest, 200)}`,
        page: t.pageFrom,
      });
    });
    t.formulas.slice(0, 3).forEach((f, k) => {
      const pool = others.flatMap(o => o.formulas.map(of => ({ f: of.latex, topic: o.title }))).slice(0, 3);
      if (pool.length < 2) return;
      const { options, answer, order } = shuffleWithAnswer(f.latex, pool.map(p => p.f), ti * 17 + k);
      const tagged = [null, ...pool.map(p => p.topic)];
      qs.push({ prompt: f.name.startsWith(t.title) ? `Which equation is correct for ${t.title.toLowerCase()}?` : `Which formula gives ${f.name} (${t.title})?`, options, answer, distractorTopics: order.map(i => tagged[i]), formulaName: f.name, page: t.pageFrom });
    });
    return qs;
  });
}

/** Full pipeline for one source. */
export async function generateTopics(pdf: PdfText, sourceTitle: string, onProgress: (f: number) => void): Promise<GenTopic[]> {
  const sections = splitSections(pdf, sourceTitle).slice(0, 80);
  if (aiEnabled()) {
    const out: GenTopic[] = [];
    const byChapter = new Map<string, Section[]>();
    for (const s of sections) byChapter.set(s.chapter, [...(byChapter.get(s.chapter) ?? []), s]);
    const allTitles = sections.map(s => s.title);
    let done = 0;
    for (const [chapter, secs] of byChapter) {
      out.push(...await generateChapterWithAI(chapter, secs, allTitles));
      onProgress(++done / byChapter.size);
    }
    return out;
  }
  const base = sections.map(heuristicTopic);
  const qs = heuristicQuestions(base);
  onProgress(1);
  return base.map(({ defs, ...t }, i) => ({ ...t, questions: qs[i] }));
}
