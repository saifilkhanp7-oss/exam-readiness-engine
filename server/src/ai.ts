// AI wrapper for Claude (paid, best quality) or Google Gemini (has a free tier).
// Rule: the AI writes content and explains numbers — it never computes them.
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import type { GenTopic } from './content.ts';

export type Provider = 'claude' | 'gemini';
/** Which AI to use. Both keys set: Claude, unless AI_PROVIDER=gemini. */
export function aiProvider(): Provider | null {
  const claude = Boolean(process.env.ANTHROPIC_API_KEY), gemini = Boolean(process.env.GEMINI_API_KEY);
  const pref = (process.env.AI_PROVIDER || '').toLowerCase();
  if (pref === 'gemini' && gemini) return 'gemini';
  if (pref === 'claude' && claude) return 'claude';
  return claude ? 'claude' : gemini ? 'gemini' : null;
}
export const aiEnabled = () => aiProvider() !== null;
export const aiName = () => (aiProvider() === 'gemini' ? 'Gemini' : 'Claude');
/** Largest PDF chunk (raw bytes) we send in one request. Gemini inline requests are smaller. */
export const maxChunkBytes = () => (aiProvider() === 'gemini' ? 14 : 18) * 1024 * 1024;

const CLAUDE_MODEL = process.env.AI_MODEL || 'claude-sonnet-5-5';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
let client: Anthropic | null = null;
const claude = () => (client ??= new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }));

/** Gemini's free daily quota is used up. The job waits and carries on after the reset. */
export class AiDailyLimitError extends Error {
  constructor() { super('Gemini free daily limit reached'); }
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** JSON Schema (as used for Claude tools) → Gemini responseSchema (OpenAPI subset). */
function toGeminiSchema(s: any): any {
  const types: string[] = Array.isArray(s.type) ? s.type : [s.type];
  const t = types.find(x => x !== 'null') ?? 'string';
  const out: any = { type: t.toUpperCase() };
  if (types.includes('null')) out.nullable = true;
  if (s.description) out.description = s.description;
  if (s.properties) {
    out.properties = Object.fromEntries(Object.entries(s.properties).map(([k, v]) => [k, toGeminiSchema(v)]));
    out.propertyOrdering = Object.keys(s.properties);
  }
  if (s.required) out.required = s.required;
  if (s.items) out.items = toGeminiSchema(s.items);
  return out;
}

interface GeminiAsk { system: string; text: string; pdf?: Uint8Array | null; schema?: object; maxTokens: number }

/** Interactions API (Google's current API; works with the new "AQ." auth keys). Falls back to generateContent if needed. */
let useLegacy = false;
async function gemini(a: GeminiAsk, retries: number): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    const legacy = useLegacy;
    const url = legacy
      ? `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`
      : 'https://generativelanguage.googleapis.com/v1beta/interactions';
    const body = legacy ? {
      systemInstruction: { parts: [{ text: a.system }] },
      contents: [{ role: 'user', parts: [...(a.pdf ? [{ inline_data: { mime_type: 'application/pdf', data: Buffer.from(a.pdf).toString('base64') } }] : []), { text: a.text }] }],
      generationConfig: { maxOutputTokens: a.maxTokens, ...(a.schema ? { responseMimeType: 'application/json', responseSchema: toGeminiSchema(a.schema) } : {}) },
    } : {
      model: GEMINI_MODEL,
      system_instruction: a.system,
      input: [...(a.pdf ? [{ type: 'document', data: Buffer.from(a.pdf).toString('base64'), mime_type: 'application/pdf' }] : []), { type: 'text', text: a.text }],
      generation_config: { max_output_tokens: a.maxTokens },
      ...(a.schema ? { response_format: { type: 'text', mime_type: 'application/json', schema: a.schema } } : {}),
    };
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY!.trim() },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      const data: any = await res.json();
      let text = '';
      if (legacy) {
        const cand = data.candidates?.[0];
        text = (cand?.content?.parts ?? []).filter((p: any) => !p.thought && typeof p.text === 'string').map((p: any) => p.text).join('');
        if (cand?.finishReason === 'MAX_TOKENS') throw new Error('Gemini answer was cut off (too long)');
        if (!text) throw new Error(`Gemini returned no text (${cand?.finishReason ?? data.promptFeedback?.blockReason ?? 'unknown'})`);
      } else {
        text = (data.steps ?? []).filter((st: any) => st.type === 'model_output')
          .flatMap((st: any) => st.content ?? []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('')
          || data.output_text || (data.outputs ?? []).filter((o: any) => o.type === 'text').map((o: any) => o.text).join('');
        if (!text) throw new Error(`Gemini returned no text (status ${data.status ?? 'unknown'}${data.errors?.length ? ': ' + JSON.stringify(data.errors).slice(0, 200) : ''})`);
      }
      return text;
    }
    const err: any = await res.json().catch(() => ({}));
    const msg = `${res.status} ${err.error?.status ?? ''} ${err.error?.message ?? ''}`;
    const details = JSON.stringify(err.error?.details ?? []);
    // The newer API missing or rejecting the request shape (not a key problem): try the older one once.
    if (!legacy && (res.status === 404 || (res.status === 400 && /unknown name|invalid json|cannot find field/i.test(msg)))) {
      console.warn('[AI] Gemini Interactions API not usable, switching to generateContent:', msg);
      useLegacy = true; attempt--; continue;
    }
    // Free tier: per-day quota → wait for the reset; per-minute quota or overload → short wait and retry.
    if (res.status === 429 && /PerDay/i.test(details + msg)) throw new AiDailyLimitError();
    if ((res.status === 429 || res.status === 503 || res.status === 500) && attempt < retries) {
      const delay = Number(/"retryDelay":"(\d+)/.exec(details)?.[1] ?? 20);
      await sleep(Math.min(70, delay + 2) * 1000);
      continue;
    }
    throw new Error(`Gemini error: ${msg}`);
  }
}

/** Ask for structured output matching SAVE_TOOL's schema. Returns the parsed object. */
async function askTopics(system: string, pdf: Uint8Array | null | undefined, text: string): Promise<unknown> {
  if (aiProvider() === 'gemini') {
    const out = await gemini({ system, text, pdf, schema: SAVE_TOOL.input_schema, maxTokens: 32768 }, 4);
    try { return JSON.parse(out.trim().replace(/^```(?:json)?\s*|\s*```$/g, '')); } catch { return {}; } // invalid JSON → schema check fails → one retry
  }
  const content = pdf ? [pdfDoc(pdf), { type: 'text' as const, text }] : [{ type: 'text' as const, text }];
  const res = await claude().messages.create({
    model: CLAUDE_MODEL, max_tokens: 16000, system,
    tools: [SAVE_TOOL], tool_choice: { type: 'tool', name: 'save_topics' },
    messages: [{ role: 'user', content }],
  });
  const call = res.content.find(c => c.type === 'tool_use');
  return call && 'input' in call ? call.input : {};
}

/** Plain text answer (used for small jobs: question matching, wording). */
async function askText(system: string, text: string, maxTokens: number, retries = 2): Promise<string> {
  if (aiProvider() === 'gemini') {
    return gemini({ system, text, maxTokens: Math.max(maxTokens, 8192) }, retries);
  }
  const res = await claude().messages.create({ model: CLAUDE_MODEL, max_tokens: maxTokens, system, messages: [{ role: 'user', content: text }] });
  return res.content.map(c => (c.type === 'text' ? c.text : '')).join('');
}

const TopicSchema = z.object({
  title: z.string().min(2),
  difficulty: z.number().min(0).max(1),
  importance: z.number().min(0).max(10),
  est_learn_min: z.number().min(5).max(300),
  line: z.string(),
  compact: z.string(),
  detailed: z.string(),
  simple: z.string(),
  page_from: z.number().int().optional(),
  page_to: z.number().int().optional(),
  chapter: z.string().optional(),
  formulas: z.array(z.object({ name: z.string(), latex: z.string(), meaning: z.string().optional() })).default([]),
  questions: z.array(z.object({
    prompt: z.string(),
    options: z.array(z.string()).length(4),
    answer: z.number().int().min(0).max(3),
    explanation: z.string(),
    option_topics: z.array(z.string().nullable()).length(4),
  })).default([]),
});
const ChapterSchema = z.object({ topics: z.array(TopicSchema) });

// The answer comes back through a tool call, so LaTeX backslashes survive JSON intact.
const SAVE_TOOL = {
  name: 'save_topics',
  description: 'Save the exam-prep topics made from this part of the book.',
  input_schema: {
    type: 'object' as const,
    properties: {
      topics: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            difficulty: { type: 'number', description: '0 easy to 1 hard' },
            importance: { type: 'number', description: '0-10, how likely in exams' },
            est_learn_min: { type: 'number', description: 'minutes to learn it the first time' },
            line: { type: 'string', description: 'One sentence: the single most important fact. Math in $...$.' },
            compact: { type: 'string', description: '3-6 markdown bullets. Math in $...$.' },
            detailed: { type: 'string', description: 'Full markdown explanation with an example. Inline math $...$, important equations on their own line as $$...$$.' },
            simple: { type: 'string', description: 'Plain-language paragraph a 14-year-old understands. Minimal math.' },
            page_from: { type: 'integer', description: 'Only for handwritten/scanned pages: first page number (as given in the message) this topic is on' },
            page_to: { type: 'integer', description: 'Only for handwritten/scanned pages: last page number this topic is on' },
            chapter: { type: 'string', description: 'Only for handwritten/scanned pages: the chapter or unit heading this topic falls under, if the notes show one' },
            formulas: {
              type: 'array',
              description: 'Every important formula, definition or condition in this section, complete.',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string', description: 'Short name, e.g. "Lagrangian" or "Second-order sufficient condition"' },
                  latex: { type: 'string', description: 'The complete formula as LaTeX, without $ signs, e.g. "L(x,\\lambda)=f(x)-\\sum_{i=1}^{m}\\lambda_i c_i(x)"' },
                  meaning: { type: 'string', description: 'What each symbol means and when it applies, one sentence. Include the book equation number if any.' },
                },
                required: ['name', 'latex', 'meaning'],
              },
            },
            questions: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  prompt: { type: 'string', description: 'Math in $...$' },
                  options: { type: 'array', items: { type: 'string' }, description: 'Exactly 4. Math in $...$' },
                  answer: { type: 'integer', description: 'index 0-3 of the correct option' },
                  explanation: { type: 'string' },
                  option_topics: { type: 'array', items: { type: ['string', 'null'] }, description: 'For each option, the title of the topic it really belongs to; null for the correct one' },
                },
                required: ['prompt', 'options', 'answer', 'explanation', 'option_topics'],
              },
            },
          },
          required: ['title', 'difficulty', 'importance', 'est_learn_min', 'line', 'compact', 'detailed', 'simple', 'formulas', 'questions'],
        },
      },
    },
    required: ['topics'],
  },
};

const SYSTEM = `You turn textbook chapters into exam-prep material for a student, and save it with the save_topics tool.
Rules:
- Read formulas from the attached PDF pages, not from the extracted text (extracted text often garbles maths). Copy every formula exactly and completely: subscripts, superscripts, sums, norms, sets and conditions.
- Write ALL maths as LaTeX: inline $...$ and display $$...$$ in notes, plain LaTeX (no $) in formulas[].latex. Use \\lambda, x_k, \\nabla f(x^*), \\|x\\|, \\in, \\le, \\sum_{i=1}^m and so on. Never write maths as plain Unicode text.
- One topic per section given. 4-8 multiple-choice questions per topic; wrong options plausible and, where possible, from a closely related topic in the list given (this is used to detect confusion).
- Simple English. Never invent facts that are not in the book.`;

const pdfDoc = (bytes: Uint8Array) => ({
  type: 'document' as const,
  source: { type: 'base64' as const, media_type: 'application/pdf' as const, data: Buffer.from(bytes).toString('base64') },
});

export async function generateChapterWithAI(
  chapter: string,
  sections: { title: string; pageFrom: number; pageTo: number; text: string }[],
  allTopicTitles: string[],
  pagesPdf?: Uint8Array | null,
): Promise<GenTopic[]> {
  const body = sections.map(s => `### ${s.title} (book pages ${s.pageFrom}-${s.pageTo})\n${s.text.slice(0, 12000)}`).join('\n\n');
  const text = `Chapter: ${chapter}\nAll topic titles in this book (for option_topics): ${JSON.stringify(allTopicTitles)}\n\n`
    + (pagesPdf ? 'The attached PDF contains exactly these pages. ' : '')
    + `Make one topic per section below. Extracted text (may have broken maths) for reference:\n\n${body}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await askTopics(SYSTEM, pagesPdf, text);
    try {
      const json = ChapterSchema.parse(raw);
      return json.topics.map((t, i) => {
        const sec = sections[Math.min(i, sections.length - 1)];
        return {
          title: t.title, chapter, difficulty: t.difficulty, importance: Math.max(0.5, t.importance),
          estLearnMin: Math.round(t.est_learn_min), pageFrom: sec.pageFrom, pageTo: sec.pageTo,
          line: t.line, compact: t.compact, detailed: t.detailed, simple: t.simple,
          formulas: t.formulas.map(f => ({ ...f, latex: f.latex.trim().replace(/^\$+|\$+$/g, '') })),
          questions: t.questions.map(q => ({ prompt: q.prompt, options: q.options, answer: q.answer, explanation: q.explanation, distractorTopics: q.option_topics, page: sec.pageFrom })),
        };
      });
    } catch (e) {
      if (attempt === 1) throw new Error(`AI returned invalid content for "${chapter}": ${(e as Error).message}`);
    }
  }
  return [];
}

const HANDWRITTEN = `
These pages are handwritten notes, photos or scans, so there is no extracted text: read the page images themselves.
- Read the handwriting carefully. Where a word is unclear, use the subject and nearby words to work out what was meant; never make up content that is not on the page.
- Decide the topics yourself: one topic per main heading or main idea (usually 1-3 pages each). Give page_from/page_to using the page numbers in the message, and chapter if the notes show a chapter or unit heading.
- If the first page clearly continues the last topic from the previous pages, use exactly that topic's title so the two parts are joined.
- Cross-outs and doodles are not content.`;

/** Handwritten or scanned pages: no usable text, so the AI reads the page images and finds the topics itself. */
export async function generateFromPagesWithAI(
  sourceTitle: string,
  pagesPdf: Uint8Array,
  firstPage: number,
  lastPage: number,
  knownTitles: string[],
): Promise<GenTopic[]> {
  const text = `Notes: ${sourceTitle}\nThe attached PDF is pages ${firstPage}-${lastPage} of the student's notes (attached page 1 = page ${firstPage}).\n`
    + (knownTitles.length ? `Topics already made from earlier pages (reuse a title only if these pages continue it; use these for option_topics too): ${JSON.stringify(knownTitles)}\n` : '')
    + 'Make the topics for these pages.';
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await askTopics(SYSTEM + HANDWRITTEN, pagesPdf, text);
    try {
      const json = ChapterSchema.parse(raw);
      const clamp = (n: number | undefined, d: number) => Math.min(lastPage, Math.max(firstPage, n ?? d));
      return json.topics.map(t => {
        const from = clamp(t.page_from, firstPage), to = Math.max(from, clamp(t.page_to, from));
        return {
          title: t.title, chapter: t.chapter?.trim() || sourceTitle, difficulty: t.difficulty, importance: Math.max(0.5, t.importance),
          estLearnMin: Math.round(t.est_learn_min), pageFrom: from, pageTo: to,
          line: t.line, compact: t.compact, detailed: t.detailed, simple: t.simple,
          formulas: t.formulas.map(f => ({ ...f, latex: f.latex.trim().replace(/^\$+|\$+$/g, '') })),
          questions: t.questions.map(q => ({ prompt: q.prompt, options: q.options, answer: q.answer, explanation: q.explanation, distractorTopics: q.option_topics, page: from })),
        };
      });
    } catch (e) {
      if (attempt === 1) throw new Error(`AI returned invalid content for pages ${firstPage}-${lastPage}: ${(e as Error).message}`);
    }
  }
  return [];
}

// ---------- explanations ----------

export type Insight =
  | { kind: 'fade'; topic: string; days: number; reviewsNeeded: number }
  | { kind: 'danger'; topic: string; confidence: number; accuracy: number }
  | { kind: 'confusion'; a: string; b: string; count: number }
  | { kind: 'pattern'; a: string; b: string; pct: number }
  | { kind: 'triage'; skipMarks: number; doCount: number; skipCount: number };

/** Template sentences (always available). With a key, the AI rewrites them more naturally, given the same numbers. */
export function insightSentence(i: Insight): string {
  switch (i.kind) {
    case 'fade': return `${i.topic} fades from your memory in ${Math.max(1, Math.round(i.days))} day${Math.round(i.days) === 1 ? '' : 's'}. Revise it ${i.reviewsNeeded === 1 ? 'once' : i.reviewsNeeded === 2 ? 'twice' : `${i.reviewsNeeded} times`} before the exam.`;
    case 'danger': return `You rate ${i.topic} ${Math.round(i.confidence / 20 * 10) / 10}/5 but score ${Math.round(i.accuracy)}%. This is one of your most risky topics.`;
    case 'confusion': return `You mixed up ${i.a} and ${i.b} ${i.count} times. Take the "tell them apart" quiz.`;
    case 'pattern': {
      const where = (b: string) => (b.includes('session') ? `in ${b}` : `in the ${b}`);
      const how = i.pct >= 100 ? `about ${(1 + i.pct / 100).toFixed(1)} times as long as` : `about ${Math.round(i.pct)}% longer than`;
      return `Topics you study ${where(i.a)} stay in your memory ${how} topics you study ${where(i.b)}.`;
    }
    case 'triage': return `Not enough time for everything. Focus on ${i.doCount} topics and skip ${i.skipCount} — skipping them costs about ${Math.round(i.skipMarks)} marks.`;
  }
}

// Same sentences → same wording: cache so page loads don't call the AI again (saves credits / free quota).
const polished = new Map<string, string[]>();

export async function polishInsights(items: Insight[]): Promise<string[]> {
  const base = items.map(insightSentence);
  if (!aiEnabled() || !items.length) return base;
  const key = JSON.stringify(base);
  const hit = polished.get(key);
  if (hit) return hit;
  try {
    const text = await askText('Rewrite each sentence for a student in simple, friendly English. Keep every number exactly as given. Do not add new numbers or facts. Return a JSON array of strings, same order.',
      JSON.stringify(base), 800, 0);
    const arr = z.array(z.string()).length(base.length).parse(JSON.parse(text.slice(text.indexOf('['), text.lastIndexOf(']') + 1)));
    if (polished.size > 500) polished.clear();
    polished.set(key, arr);
    return arr;
  } catch {
    polished.set(key, base); // don't retry on every page load if the AI is out of credits or quota
    return base;
  }
}

/** Map past-paper questions to topic indices (null when none fits). */
export async function mapQuestionsWithAI(questions: string[], topicTitles: string[]): Promise<(number | null)[]> {
  const text = await askText('You match exam questions to syllabus topics. Return ONLY a JSON array with one entry per question: the index of the best topic, or null if no topic fits.',
    `Topics:\n${topicTitles.map((t, i) => `${i}: ${t}`).join('\n')}\n\nQuestions:\n${questions.map((q, i) => `${i + 1}. ${q.slice(0, 600)}`).join('\n')}`, 4000);
  const arr = z.array(z.number().int().min(0).max(topicTitles.length - 1).nullable()).length(questions.length)
    .parse(JSON.parse(text.slice(text.indexOf('['), text.lastIndexOf(']') + 1)));
  return arr;
}
