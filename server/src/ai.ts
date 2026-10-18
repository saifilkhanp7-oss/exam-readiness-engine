// Claude API wrapper. Rule: the AI writes content and explains numbers — it never computes them.
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import type { GenTopic } from './content.ts';

const MODEL = process.env.AI_MODEL || 'claude-sonnet-5-5';
let client: Anthropic | null = null;
export const aiEnabled = () => Boolean(process.env.ANTHROPIC_API_KEY);
const ai = () => (client ??= new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }));

const TopicSchema = z.object({
  title: z.string().min(2),
  difficulty: z.number().min(0).max(1),
  importance: z.number().min(0).max(10),
  est_learn_min: z.number().min(5).max(300),
  line: z.string(),
  compact: z.string(),
  detailed: z.string(),
  simple: z.string(),
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

const SYSTEM = `You turn textbook chapters into exam-prep material for a student.
Return ONLY JSON matching: {"topics":[{"title","difficulty"(0-1),"importance"(0-10, how likely in exams),"est_learn_min","line"(one sentence, the single most important fact),"compact"(3-6 markdown bullets),"detailed"(markdown, full explanation with examples, use $...$ for math),"simple"(plain-language paragraph a 14-year-old understands),"formulas":[{"name","latex","meaning"}],"questions":[{"prompt","options"(4),"answer"(index),"explanation","option_topics"(for each option, the title of the topic it really belongs to, or null for the correct one)}]}]}
Rules: 4-8 MCQs per topic. Wrong options must be plausible and, where possible, come from a closely related topic in the list given (this is used to detect confusion). Use simple English. Never invent facts that are not in the text.`;

export async function generateChapterWithAI(
  chapter: string,
  sections: { title: string; pageFrom: number; pageTo: number; text: string }[],
  allTopicTitles: string[],
): Promise<GenTopic[]> {
  const body = sections.map(s => `### ${s.title} (pages ${s.pageFrom}-${s.pageTo})\n${s.text.slice(0, 12000)}`).join('\n\n');
  const user = `Chapter: ${chapter}\nAll topic titles in this book (for option_topics): ${JSON.stringify(allTopicTitles)}\n\nMake one topic per section below.\n\n${body}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await ai().messages.create({ model: MODEL, max_tokens: 16000, system: SYSTEM, messages: [{ role: 'user', content: user }] });
    const text = res.content.map(c => (c.type === 'text' ? c.text : '')).join('');
    try {
      const json = ChapterSchema.parse(JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)));
      return json.topics.map((t, i) => {
        const sec = sections[Math.min(i, sections.length - 1)];
        return {
          title: t.title, chapter, difficulty: t.difficulty, importance: Math.max(0.5, t.importance),
          estLearnMin: Math.round(t.est_learn_min), pageFrom: sec.pageFrom, pageTo: sec.pageTo,
          line: t.line, compact: t.compact, detailed: t.detailed, simple: t.simple, formulas: t.formulas,
          questions: t.questions.map(q => ({ prompt: q.prompt, options: q.options, answer: q.answer, explanation: q.explanation, distractorTopics: q.option_topics, page: sec.pageFrom })),
        };
      });
    } catch (e) {
      if (attempt === 1) throw new Error(`AI returned invalid content for "${chapter}": ${(e as Error).message}`);
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

/** Template sentences (always available). With a key, Claude rewrites them more naturally, given the same numbers. */
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

export async function polishInsights(items: Insight[]): Promise<string[]> {
  const base = items.map(insightSentence);
  if (!aiEnabled() || !items.length) return base;
  try {
    const res = await ai().messages.create({
      model: MODEL, max_tokens: 800,
      system: 'Rewrite each sentence for a student in simple, friendly English. Keep every number exactly as given. Do not add new numbers or facts. Return a JSON array of strings, same order.',
      messages: [{ role: 'user', content: JSON.stringify(base) }],
    });
    const text = res.content.map(c => (c.type === 'text' ? c.text : '')).join('');
    const arr = z.array(z.string()).length(base.length).parse(JSON.parse(text.slice(text.indexOf('['), text.lastIndexOf(']') + 1)));
    return arr;
  } catch {
    return base;
  }
}

/** Map past-paper questions to topic indices (null when none fits). */
export async function mapQuestionsWithAI(questions: string[], topicTitles: string[]): Promise<(number | null)[]> {
  const res = await ai().messages.create({
    model: MODEL, max_tokens: 4000,
    system: 'You match exam questions to syllabus topics. Return ONLY a JSON array with one entry per question: the index of the best topic, or null if no topic fits.',
    messages: [{ role: 'user', content: `Topics:\n${topicTitles.map((t, i) => `${i}: ${t}`).join('\n')}\n\nQuestions:\n${questions.map((q, i) => `${i + 1}. ${q.slice(0, 600)}`).join('\n')}` }],
  });
  const text = res.content.map(c => (c.type === 'text' ? c.text : '')).join('');
  const arr = z.array(z.number().int().min(0).max(topicTitles.length - 1).nullable()).length(questions.length)
    .parse(JSON.parse(text.slice(text.indexOf('['), text.lastIndexOf(']') + 1)));
  return arr;
}
