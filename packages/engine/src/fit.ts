// Personal model: after ~100 answers, fit the memory model's parameters to this student's own history.
// Method: replay every topic's quizzes in order; before each delayed quiz, the model predicts the chance
// of a correct answer (mastery × recall). We choose parameters that make those predictions most accurate
// (lowest log loss), using simple coordinate descent with a light pull towards the defaults.
import {
  DEFAULT_PARAMS, DAY, initialState, recall, updateAfterQuiz, type MemoryState, type QuizAnswer, type UserParams,
} from './memory.ts';

export interface FitQuiz { at: number; answers: QuizAnswer[]; context?: string | null }
export interface FitTopic { difficulty: number; context?: string | null; quizzes: FitQuiz[] }

export interface PersonalParams extends UserParams {
  /** Multiplier on a topic's starting memory strength by the time of day it was first learned, relative to the
   *  student's most common study time (e.g. "late night": 0.7 means topics learned late at night start 30% weaker). */
  contextMult: Record<string, number>;
}

export interface FitResult {
  params: PersonalParams;
  lossDefault: number;   // average log loss with the default model
  lossFitted: number;    // average log loss with the fitted model
  predictions: number;   // how many answers were predicted
  improvement: number;   // 0..1, share of the default loss removed
}

export const MIN_ANSWERS_TO_FIT = 100;

export function startState(difficulty: number, p: UserParams, context?: string | null): MemoryState {
  const s = initialState(difficulty, p);
  const mult = (p as PersonalParams).contextMult?.[context ?? ''] ?? 1;
  return { ...s, halfLife: s.halfLife * mult };
}

export function applyContext(s: MemoryState, p: UserParams, context?: string | null): MemoryState {
  const m = (p as PersonalParams).contextMult?.[context ?? ''];
  return m ? { ...s, halfLife: Math.min(365, Math.max(0.2, s.halfLife * m)) } : s;
}

/** Replays one topic and returns its final state plus the log loss of every prediction made on the way. */
export function replayTopic(t: FitTopic, p: UserParams, medianMs = 10000): { state: MemoryState; losses: number[] } {
  let s = startState(t.difficulty, p, t.context);
  const losses: number[] = [];
  for (const q of [...t.quizzes].sort((a, b) => a.at - b.at)) {
    if (s.lastReviewAt != null) {
      const tDays = (q.at - s.lastReviewAt) / DAY;
      if (tDays >= 0.25) {
        const pred = Math.min(0.98, Math.max(0.02, s.mastery * recall(s.halfLife, tDays)));
        for (const a of q.answers) losses.push(-(a.correct ? Math.log(pred) : Math.log(1 - pred)));
      }
    }
    s = updateAfterQuiz(s, q.answers, q.at, t.difficulty, medianMs, p);
  }
  return { state: s, losses };
}

function totalLoss(topics: FitTopic[], p: UserParams, medianMs: number) {
  let sum = 0, n = 0;
  for (const t of topics) { const { losses } = replayTopic(t, p, medianMs); for (const l of losses) { sum += l; n++; } }
  return { avg: n ? sum / n : 0, n };
}

export function fitUserParams(topics: FitTopic[], medianMs = 10000, base: UserParams = DEFAULT_PARAMS): FitResult {
  // Two parameters the history can pin down reliably: how strong a new topic starts, and how much a good review
  // strengthens it. (Time-of-day effects are measured separately and only reported when clear: see insights.ts.)
  const p: PersonalParams = { ...base, contextMult: {} };
  const keys: { get: () => number; set: (v: number) => void; lo: number; hi: number }[] = [
    { get: () => p.growth, set: v => { p.growth = v; }, lo: 0.2, hi: 4 },
    { get: () => p.userPrior, set: v => { p.userPrior = v; }, lo: 0.25, hi: 6 },
  ];
  // Light regularisation keeps parameters near the defaults unless the data clearly says otherwise.
  const penalty = () => 0.01 * (Math.log(p.growth / base.growth) ** 2 + Math.log(p.userPrior) ** 2);
  const objective = () => totalLoss(topics, p, medianMs).avg + penalty();

  const def = totalLoss(topics, base, medianMs);
  let best = objective();
  for (const step of [2, 1.4, 1.15, 1.05]) {
    for (let pass = 0; pass < 2; pass++) {
      let improved = false;
      for (const k of keys) {
        const cur = k.get();
        for (const f of [1 / step, step]) {
          const v = Math.min(k.hi, Math.max(k.lo, cur * f));
          k.set(v);
          const o = objective();
          if (o < best - 1e-6) { best = o; improved = true; break; }
          k.set(cur);
        }
      }
      if (!improved) break;
    }
  }
  const fitted = totalLoss(topics, p, medianMs);
  const round = (x: number) => Math.round(x * 1000) / 1000;
  p.growth = round(p.growth); p.userPrior = round(p.userPrior);
  return {
    params: p,
    lossDefault: def.avg,
    lossFitted: fitted.avg,
    predictions: fitted.n,
    improvement: def.avg > 0 ? Math.max(0, (def.avg - fitted.avg) / def.avg) : 0,
  };
}
