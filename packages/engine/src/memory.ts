// Personal forgetting curve for one topic (or one formula).
// Recall after t days: R(t) = 2^(-t / h), where h is the half-life in days.

export const DAY = 24 * 60 * 60 * 1000;

export interface MemoryState {
  halfLife: number;        // days until recall falls to 50%
  mastery: number;         // 0..1, how much you know right after studying
  lastReviewAt: number | null; // ms timestamp, null = never studied
  nReviews: number;
  hlUncertainty: number;   // spread of log(halfLife), used for the score range
}

export interface UserParams {
  baseHalfLife: number;    // days, for a medium topic
  growth: number;          // G: how much a good review strengthens memory
  userPrior: number;       // personal multiplier on starting half-life
  targetRecall: number;    // review when recall drops to this
}

export const DEFAULT_PARAMS: UserParams = {
  baseHalfLife: 1.5,
  growth: 1.2,
  userPrior: 1,
  targetRecall: 0.85,
};

export interface QuizAnswer {
  correct: boolean;
  confidence: number;      // 1..5
  responseMs: number;
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

export function recall(halfLife: number, tDays: number): number {
  if (tDays <= 0) return 1;
  return Math.pow(2, -tDays / halfLife);
}

export function recallAt(s: MemoryState, at: number): number {
  if (s.lastReviewAt == null) return 0;
  return recall(s.halfLife, (at - s.lastReviewAt) / DAY);
}

export function difficultyFactor(d: number): number {
  return 1.6 - 1.2 * clamp(d, 0, 1);
}

export function initialState(difficulty: number, p: UserParams = DEFAULT_PARAMS): MemoryState {
  return {
    halfLife: p.baseHalfLife * difficultyFactor(difficulty) * p.userPrior,
    mastery: 0,
    lastReviewAt: null,
    nReviews: 0,
    hlUncertainty: 0.6,
  };
}

function confFactor(conf: number): number {
  if (conf <= 2) return 0.9;
  if (conf === 3) return 1.0;
  return 1.03;
}

/** Strengthening from one successful review. Bigger when you review close to forgetting (spacing effect). */
export function growthFactor(difficulty: number, recallAtReview: number, score: number, p: UserParams): number {
  return 1 + p.growth * (1 - clamp(difficulty, 0, 1)) * Math.pow(1 - clamp(recallAtReview, 0, 1), 0.6) * score + 0.1 * score;
}

/**
 * Update a topic's memory after a quiz.
 * - Same-day quiz (or first ever): measures mastery, starts the clock.
 * - Later quiz: score / mastery tells us how much has faded → observed half-life,
 *   blended with what we believed, then strengthened by the review itself.
 */
export function updateAfterQuiz(
  s: MemoryState,
  answers: QuizAnswer[],
  at: number,
  difficulty: number,
  medianResponseMs: number,
  p: UserParams = DEFAULT_PARAMS,
): MemoryState {
  if (answers.length === 0) return s;
  const score = answers.filter(a => a.correct).length / answers.length;
  const correct = answers.filter(a => a.correct);
  const cf = correct.length ? correct.reduce((acc, a) => acc + confFactor(a.confidence), 0) / correct.length : 1;
  const slow = answers.filter(a => a.responseMs > medianResponseMs * 2).length / answers.length;
  const sf = slow > 0.5 ? 0.95 : 1;
  const pAdj = clamp(score * cf * sf, 0.05, 0.98);

  const next: MemoryState = { ...s, nReviews: s.nReviews + 1, lastReviewAt: at };
  const tDays = s.lastReviewAt == null ? 0 : (at - s.lastReviewAt) / DAY;

  if (s.lastReviewAt == null || tDays < 0.25) {
    // Fresh knowledge: this is mastery, not memory decay.
    next.mastery = s.mastery === 0 ? pAdj : 0.6 * s.mastery + 0.4 * pAdj;
    if (s.lastReviewAt != null && pAdj >= 0.6) next.halfLife = s.halfLife * 1.05;
    return next;
  }

  const m = Math.max(s.mastery, 0.3);
  const pRel = clamp(pAdj / m, 0.05, 0.95);
  // A near-perfect score only proves memory lasted *at least* this long, so cap what we read from it.
  const ceiling = Math.max(s.halfLife * 2, tDays * 3);
  const hObserved = clamp(Math.min(-tDays / Math.log2(pRel), ceiling), 0.2, 365);
  const alpha = Math.max(0.15, 0.5 / Math.sqrt(s.nReviews + 1));
  const hBlend = (1 - alpha) * s.halfLife + alpha * hObserved;
  const rAtReview = recall(s.halfLife, tDays);
  // Delayed scores also say something about mastery: score ≈ mastery × recall.
  const impliedMastery = Math.min(1, pAdj / Math.max(0.2, rAtReview));

  next.halfLife = pAdj >= 0.6
    ? hBlend * growthFactor(difficulty, rAtReview, pAdj, p)
    : hBlend * 0.7;
  next.halfLife = clamp(next.halfLife, 0.2, 365);
  next.hlUncertainty = Math.max(0.12, s.hlUncertainty * 0.85);
  next.mastery = clamp(0.8 * s.mastery + 0.2 * impliedMastery, 0.05, 1);
  return next;
}

/** When recall will drop to the target. */
export function nextReviewAt(s: MemoryState, target = DEFAULT_PARAMS.targetRecall): number | null {
  if (s.lastReviewAt == null) return null;
  return s.lastReviewAt + s.halfLife * Math.log2(1 / target) * DAY;
}

/** Days until recall drops to 50% from now (the "fades in N days" number). */
export function fadeDays(s: MemoryState, now: number): number | null {
  if (s.lastReviewAt == null) return null;
  const left = s.lastReviewAt + s.halfLife * DAY - now;
  return Math.max(0, left / DAY);
}
