// Turns extracted book text into topics, notes (3 levels), formulas and quiz questions.
// Uses Claude when ANTHROPIC_API_KEY is set; otherwise a heuristic fallback so the app runs without a key.
import type { PdfText } from './pdf.ts';
import { AiDailyLimitError, aiEnabled, aiName, pagesPerAiRequest, generateChapterWithAI, generateFromPagesWithAI, maxChunkBytes } from './ai.ts';

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
      // Some PDFs have blank or "." outline entries: skip anything without a real word in it.
      const title = o.title.replace(/\s+/g, ' ').trim();
      if (idx >= 0 && /[A-Za-z]{2}|\d/.test(title)) marks.push({ idx, title, level: o.level === 1 ? 1 : 2 });
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

const count = (s: string, ch: string) => s.split(ch).length - 1;
/** A line that is a whole formula, not a broken fragment of one (offline method only). */
export const isFormulaLine = (l: string) => {
  const t = l.trim().replace(/\s*\(\d+(\.\d+)*\)\s*$/, ''); // drop a trailing equation number
  if (!t.includes('=') || t.length < 5 || t.length > 90) return false;
  if (!/[A-Za-zΔΣπθλμρα-ω∇]/.test(t) || /[.?!]$/.test(t)) return false;
  if ((t.match(/\b[a-z]{4,}\b/gi) ?? []).length > 6) return false;               // prose, not maths
  if (/^[)\]}|=,+\-−*/·×∈≤≥<>]/.test(t) || /[=(,+\-−*/[{·×∈≤≥<>:]$/.test(t)) return false; // starts or ends mid-formula
  if (count(t, '(') !== count(t, ')') || count(t, '[') !== count(t, ']') || count(t, '{') !== count(t, '}')) return false;
  if (count(t, '|') % 2 || count(t, '‖') % 2) return false;
  const [lhs, ...rest] = t.split('=');
  const rhs = rest.join('=');
  if (lhs.replace(/\s/g, '').length < 1 || rhs.replace(/[\s:]/g, '').length < 1) return false;
  if (/^\s*[a-z]\s*$/i.test(lhs) && /^\s*\d+\s*$/.test(rhs)) return false;           // "i = 1"
  if ((t.match(/[A-Za-z0-9α-ωΑ-Ω∇]/g) ?? []).length < 3) return false;
  if (rhs.replace(/[\s:]/g, '').length === 1 && /^[a-z]$/i.test(rhs.trim())) return false;    // "xk = x": a fragment
  return true;
};

const UNI: Record<string, string> = {
  'α': '\\alpha ', 'β': '\\beta ', 'γ': '\\gamma ', 'δ': '\\delta ', 'ε': '\\varepsilon ', 'θ': '\\theta ', 'λ': '\\lambda ', 'μ': '\\mu ',
  'ν': '\\nu ', 'π': '\\pi ', 'ρ': '\\rho ', 'σ': '\\sigma ', 'τ': '\\tau ', 'φ': '\\phi ', 'ω': '\\omega ', 'Δ': '\\Delta ', 'Σ': '\\Sigma ',
  'Ω': '\\Omega ', '∇': '\\nabla ', '∈': '\\in ', '∉': '\\notin ', '≤': '\\le ', '≥': '\\ge ', '≠': '\\ne ', '≈': '\\approx ', '∞': '\\infty ',
  '→': '\\to ', '⇒': '\\Rightarrow ', '⇔': '\\Leftrightarrow ', '∀': '\\forall ', '∃': '\\exists ', '∂': '\\partial ', '×': '\\times ',
  '·': '\\cdot ', '∩': '\\cap ', '∪': '\\cup ', '⊂': '\\subset ', '⊆': '\\subseteq ', 'ℓ': '\\ell ', '⋆': '^{\\star}', '∗': '^{*}',
  '‖': '\\| ', '∑': '\\sum ', '∏': '\\prod ', '√': '\\sqrt ', '°': '^{\\circ}', '∅': '\\emptyset ', '⊤': '^{\\top}', 'ℝ': '\\mathbb{R}',
};
/** Turn Unicode maths from a PDF's text layer into LaTeX so it typesets (best effort, offline method). */
export function unicodeToLatex(s: string): string {
  return [...s].map(c => UNI[c] ?? c).join('').replace(/\s+/g, ' ').trim();
}
const MATHY = /[∇∈≤≥λμσ∑∏‖⋆∂ℓ√∞]/g;

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
  for (const l of sec.text.split('\n')) if (isFormulaLine(l) && formulas.length < 8) {
    const lhs = l.split('=')[0].trim();
    const eqNo = l.match(/\((\d+(?:\.\d+)+)\)\s*$/)?.[1];
    const clean = l.trim().replace(/\s*\(\d+(\.\d+)*\)\s*$/, '');
    const name = /^[A-Za-zΔΣπθλμρ_0-9 ]{1,6}$/.test(lhs) ? lhs : eqNo ? `Equation (${eqNo})` : `${sec.title}${formulas.length ? ` (${formulas.length + 1})` : ''}`;
    // Unicode maths is converted to LaTeX; plain chemistry/words stay as they are.
    formulas.push({ name, latex: MATHY.test(clean) ? unicodeToLatex(clean) : clean });
    MATHY.lastIndex = 0;
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
/** Short, plain reason for an AI failure (credits, key, rate limit), for showing to the student. */
const short = (m: string) => m.replace(/\s+/g, ' ').replace(/AIza[\w-]+|AQ\.[\w.-]+/g, '…').slice(0, 140);
export function aiFailureReason(e: unknown): string {
  const m = String((e as Error)?.message ?? e);
  const who = aiName();
  if (e instanceof AiDailyLimitError) return `${who}'s free daily limit is used up`;
  if (/\b402\b|insufficient credits|credits/i.test(m) && who === 'OpenRouter') return 'OpenRouter has no credits for this model (pick a model ending in :free, or add credits)';
  if (/credit balance/i.test(m)) return 'Claude API has no credits left';
  if (/invalid x-api-key|authentication|401|API key not valid|API_KEY_INVALID|PERMISSION_DENIED|403/i.test(m)) return `the ${who} API key is not valid`;
  if (/NO_FREE_QUOTA/.test(m)) return `your Gemini key has no free quota for this model`;
  if (/rate.?limit|429|overloaded|529|503|RESOURCE_EXHAUSTED/i.test(m)) return `${who} refused because of its per-minute limit`;
  if (/404|NOT_FOUND/i.test(m)) return `the ${who} model name was not found`;
  if (/\b400\b|INVALID_ARGUMENT/i.test(m)) return `${who} rejected that part of the file (${short(m)})`;
  if (/cut off/i.test(m)) return `${who}'s answer was too long and got cut off`;
  if (/invalid content/i.test(m)) return `${who}'s answer was not in the expected format`;
  if (/network error|fetch failed|ECONN|ETIMEDOUT|abort/i.test(m)) return `${who} could not be reached (network problem)`;
  return `${who} had a problem (${short(m)})`;
}

/** Copy pages [from..to] (1-based) of the PDF into a small PDF, so Claude can read the real page layout and maths. */
async function pagesAsPdf(bytes: Uint8Array | undefined, from: number, to: number): Promise<Uint8Array | null> {
  if (!bytes) return null;
  try {
    const { PDFDocument } = await import('pdf-lib');
    const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
    const out = await PDFDocument.create();
    const idx = Array.from({ length: to - from + 1 }, (_, i) => from - 1 + i).filter(i => i >= 0 && i < src.getPageCount());
    for (const p of await out.copyPages(src, idx)) out.addPage(p);
    return await out.save();
  } catch { return null; } // text only, if the PDF can't be split
}

const MAX_PAGES_PER_REQUEST = 12;
// Gemini 3 models think before answering and the thinking uses the same token budget, so give them fewer pages at once.
const pagesPerRequest = () => pagesPerAiRequest(MAX_PAGES_PER_REQUEST);

export async function generateTopics(pdf: PdfText, sourceTitle: string, onProgress: (f: number) => void, onNote?: (note: string) => void, bytes?: Uint8Array): Promise<GenTopic[]> {
  const sections = splitSections(pdf, sourceTitle).slice(0, 80);
  if (aiEnabled()) {
    const out: GenTopic[] = [];
    // Group sections by chapter, then into chunks of at most MAX_PAGES_PER_REQUEST pages.
    const chunks: { chapter: string; secs: Section[] }[] = [];
    // A section longer than one request's pages is split into parts, so every page is read.
    const per = pagesPerRequest();
    const parts = sections.flatMap(s => {
      const len = s.pageTo - s.pageFrom + 1;
      if (len <= per) return [s];
      const n = Math.ceil(len / per);
      return Array.from({ length: n }, (_, k) => ({ ...s, title: k ? `${s.title} (part ${k + 1})` : s.title,
        pageFrom: s.pageFrom + k * per, pageTo: Math.min(s.pageTo, s.pageFrom + (k + 1) * per - 1) }));
    });
    for (const s of parts) {
      const last = chunks[chunks.length - 1];
      const pages = (c: Section[]) => c[c.length - 1].pageTo - c[0].pageFrom + 1;
      if (last && last.chapter === s.chapter && pages([...last.secs, s]) <= pagesPerRequest()) last.secs.push(s);
      else chunks.push({ chapter: s.chapter, secs: [s] });
    }
    const allTitles = sections.map(s => s.title);
    // If the answer for a chunk is too long and gets cut off, split the chunk in half and try each half.
    const makeChunk = async (chapter: string, secs: Section[], from: number, to: number): Promise<GenTopic[]> => {
      try {
        return await generateChapterWithAI(chapter, secs, allTitles, await pagesAsPdf(bytes, from, to));
      } catch (e) {
        if (!/cut off/i.test(String((e as Error).message))) throw e;
        if (secs.length > 1) {
          const h = Math.ceil(secs.length / 2), a = secs.slice(0, h), b = secs.slice(h);
          return [...await makeChunk(chapter, a, a[0].pageFrom, a[a.length - 1].pageTo), ...await makeChunk(chapter, b, b[0].pageFrom, b[b.length - 1].pageTo)];
        }
        if (to > from) { // one long section: read its first half only, rather than nothing
          return makeChunk(chapter, secs, from, from + Math.floor((to - from) / 2));
        }
        throw e;
      }
    };
    let done = 0;
    try {
      for (const c of chunks) {
        const from = c.secs[0].pageFrom;
        const to = Math.min(c.secs[c.secs.length - 1].pageTo, from + pagesPerRequest() * 2 - 1);
        out.push(...await makeChunk(c.chapter, c.secs, from, to));
        onProgress(++done / chunks.length);
      }
      return out;
    } catch (e) {
      if (e instanceof AiDailyLimitError) throw e; // the job waits for the daily reset instead
      // Never fail the upload because of the AI. Keep what the AI already made; the rest uses the offline method.
      console.warn('[AI] falling back to offline notes:', (e as Error).message);
      const why = aiFailureReason(e);
      const fix = /no free quota/.test(why) ? `Set GEMINI_MODEL to gemini-3.5-flash-lite in Railway, then upload again`
        : /not valid|not found/.test(why) ? 'Check the key or model name in your Railway variables, then upload again'
        : 'Delete this file and upload it again later';
      const rest = chunks.slice(done).flatMap(c => c.secs);
      if (done > 0) {
        const pg = `${rest[0].pageFrom}–${rest[rest.length - 1].pageTo}`;
        onNote?.(`${aiName()} made notes for the first part. Pages ${pg} were made with the offline method because ${why}. ${fix} for AI notes on those pages too.`);
        const base = rest.map(heuristicTopic);
        const qs = heuristicQuestions(base);
        return [...out, ...base.map(({ defs, ...t }, i) => ({ ...t, questions: qs[i] }))];
      }
      onNote?.(`Made with the offline method because ${why}. ${fix} for AI-written notes.`);
    }
  }
  const mathy = (pdf.pages.join('').match(MATHY) ?? []).length;
  MATHY.lastIndex = 0;
  const density = mathy / Math.max(1, pdf.pages.join('').length / 1000);
  if ((mathy > 12 || density > 3) && !aiEnabled()) onNote?.('This PDF has a lot of maths. The offline method can only copy formulas that come out as clean text, so some may be missing. Add a free Gemini API key (or a Claude API key) for exact LaTeX formulas and notes.');
  const base = sections.map(heuristicTopic);
  const qs = heuristicQuestions(base);
  onProgress(1);
  return base.map(({ defs, ...t }, i) => ({ ...t, questions: qs[i] }));
}

// ---------- handwritten / scanned notes ----------

const HANDWRITTEN_PAGES_PER_REQUEST = 6;

/** Handwritten, photographed or scanned notes: the AI reads the page images directly (no OCR), a few pages at a time. */
export async function generateTopicsFromPages(bytes: Uint8Array, pageCount: number, sourceTitle: string, onProgress: (f: number) => void): Promise<GenTopic[]> {
  // Build page ranges, shrinking a range when its pages are too big a file (phone photos can be several MB each).
  const ranges: [number, number, Uint8Array][] = [];
  let from = 1;
  while (from <= pageCount) {
    let to = Math.min(pageCount, from + HANDWRITTEN_PAGES_PER_REQUEST - 1);
    let pdf = await pagesAsPdf(bytes, from, to);
    while (pdf && pdf.length > maxChunkBytes() && to > from) { to = from + Math.floor((to - from) / 2); pdf = await pagesAsPdf(bytes, from, to); }
    if (!pdf) throw new Error('This PDF could not be split into pages');
    if (pdf.length > maxChunkBytes()) throw new Error(`Page ${from} is too large an image to send. Try scanning at a lower quality.`);
    ranges.push([from, to, pdf]);
    from = to + 1;
  }
  const out: GenTopic[] = [];
  for (let i = 0; i < ranges.length; i++) {
    const [a, b, pdf] = ranges[i];
    const topics = await generateFromPagesWithAI(sourceTitle, pdf, a, b, out.map(t => t.title));
    for (const t of topics) {
      const prev = out.find(o => o.title.toLowerCase() === t.title.toLowerCase());
      if (prev) {
        // The same topic carried on from the previous pages: join the two parts.
        prev.pageTo = Math.max(prev.pageTo, t.pageTo);
        prev.compact = `${prev.compact}\n${t.compact}`;
        prev.detailed = `${prev.detailed}\n\n${t.detailed}`;
        prev.formulas.push(...t.formulas);
        prev.questions.push(...t.questions);
        prev.estLearnMin += t.estLearnMin;
      } else out.push(t);
    }
    onProgress((i + 1) / ranges.length);
  }
  return out;
}
