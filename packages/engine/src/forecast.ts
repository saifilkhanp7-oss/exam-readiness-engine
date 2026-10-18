// Planner + exam-day forecast + triage. Pure functions, so the browser can rerun them for the what-if sliders.
import {
  DAY, DEFAULT_PARAMS, MemoryState, UserParams, growthFactor, initialState, recall, recallAt,
} from './memory.ts';

export interface TopicInput {
  id: number;
  title: string;
  weight: number;        // share of this subject's marks (any scale, normalised per subject)
  difficulty: number;    // 0..1
  estLearnMin: number;   // minutes needed to learn it the first time
  state: MemoryState;
  skip?: boolean;        // user chose to skip it
}

export interface SubjectInput {
  id: number;
  name: string;
  examAt: number;
  totalMarks: number;
  guessRate: number;     // 0.25 for MCQ exams, 0 for written
  topics: TopicInput[];
}

export interface PlanTask {
  day: number;           // ms, start of the day
  subjectId: number;
  topicId: number;
  kind: 'learn' | 'review';
  minutes: number;
  marksGain: number;     // expected marks this task adds on exam day
}

export interface PlanOptions {
  now: number;
  dailyMinutes: number | ((day: number) => number);
  params?: UserParams;
  learnMastery?: number; // expected mastery right after learning (user's average)
  reviewScore?: number;  // expected score on a review quiz
  movedTasks?: { topicId: number; fromDay: number; toDay: number }[];
}

export interface SubjectForecast {
  subjectId: number;
  readiness: number;     // 0..100
  readinessIfStopNow: number;
  scoreP10: number;
  scoreP50: number;
  scoreP90: number;
  totalMarks: number;
  topics: { id: number; title: string; expected: number; recallOnExam: number; marks: number }[];
}

export interface PlanResult {
  tasks: PlanTask[];
  states: Map<number, MemoryState>;
  forecasts: SubjectForecast[];
}

export const startOfDay = (ts: number) => { const d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime(); };

const marksOf = (s: SubjectInput, t: TopicInput) => {
  const total = s.topics.reduce((a, x) => a + x.weight, 0) || 1;
  return (t.weight / total) * s.totalMarks;
};

export function expectedOnExam(state: MemoryState, examAt: number, guessRate: number): number {
  if (state.lastReviewAt == null) return guessRate;
  const r = recallAt(state, examAt);
  const e = state.mastery * r;
  return Math.max(e, guessRate);
}

export function readinessOf(s: SubjectInput, states: Map<number, MemoryState>): number {
  let num = 0, den = 0;
  for (const t of s.topics) {
    const st = states.get(t.id) ?? t.state;
    num += t.weight * expectedOnExam(st, s.examAt, s.guessRate);
    den += t.weight;
  }
  return den ? (num / den) * 100 : 0;
}

/** Day-by-day greedy planner: each day, spend the free minutes on the tasks that add the most exam marks per minute. */
export function simulatePlan(subjects: SubjectInput[], opt: PlanOptions): PlanResult {
  const p = opt.params ?? DEFAULT_PARAMS;
  const learnMastery = opt.learnMastery ?? 0.78;
  const reviewScore = opt.reviewScore ?? 0.85;
  const states = new Map<number, MemoryState>();
  const learned = new Map<number, number>(); // minutes of learning done so far
  for (const s of subjects) for (const t of s.topics) states.set(t.id, { ...t.state });

  const tasks: PlanTask[] = [];
  const lastExam = Math.max(0, ...subjects.map(s => s.examAt));
  const budgetFor = (day: number) => typeof opt.dailyMinutes === 'function' ? opt.dailyMinutes(day) : opt.dailyMinutes;
  const forced = new Map<number, number[]>(); // day -> topic ids forced to that day (what-if moves)
  const blocked = new Set<string>();
  for (const m of opt.movedTasks ?? []) {
    blocked.add(`${startOfDay(m.fromDay)}:${m.topicId}`);
    const k = startOfDay(m.toDay);
    forced.set(k, [...(forced.get(k) ?? []), m.topicId]);
  }

  for (let day = startOfDay(opt.now); day < lastExam; day += DAY) {
    let budget = budgetFor(day);
    const at = Math.max(opt.now, day + 18 * 3600 * 1000); // assume evening study
    const doneToday = new Set<number>();

    type Cand = { s: SubjectInput; t: TopicInput; kind: 'learn' | 'review'; cost: number; gain: number; value: number };
    const candidates = (): Cand[] => {
      const out: Cand[] = [];
      for (const s of subjects) {
        if (s.examAt <= at) continue;
        for (const t of s.topics) {
          if (t.skip || doneToday.has(t.id) || blocked.has(`${day}:${t.id}`)) continue;
          const st = states.get(t.id)!;
          const marks = marksOf(s, t);
          const before = expectedOnExam(st, s.examAt, s.guessRate);
          if (st.lastReviewAt == null) {
            const remaining = t.estLearnMin - (learned.get(t.id) ?? 0);
            const fresh = { ...initialState(t.difficulty, p), mastery: learnMastery, lastReviewAt: at, nReviews: 1 };
            const gain = marks * (expectedOnExam(fresh, s.examAt, s.guessRate) - before);
            out.push({ s, t, kind: 'learn', cost: remaining, gain, value: gain / t.estLearnMin });
          } else {
            const r = recallAt(st, at);
            if (r > p.targetRecall) continue;
            const cost = Math.min(25, Math.max(8, Math.round(t.estLearnMin * 0.2)));
            const after: MemoryState = {
              ...st,
              halfLife: st.halfLife * growthFactor(t.difficulty, r, reviewScore, p),
              lastReviewAt: at,
              nReviews: st.nReviews + 1,
            };
            const gain = marks * (expectedOnExam(after, s.examAt, s.guessRate) - before);
            out.push({ s, t, kind: 'review', cost, gain, value: gain / cost });
          }
        }
      }
      return out;
    };

    const apply = (c: Cand, minutes: number) => {
      const st = states.get(c.t.id)!;
      if (c.kind === 'learn') {
        const done = (learned.get(c.t.id) ?? 0) + minutes;
        learned.set(c.t.id, done);
        const finished = done >= c.t.estLearnMin - 0.5;
        if (finished) states.set(c.t.id, { ...initialState(c.t.difficulty, p), mastery: learnMastery, lastReviewAt: at, nReviews: 1 });
        tasks.push({ day, subjectId: c.s.id, topicId: c.t.id, kind: 'learn', minutes, marksGain: finished ? c.gain : 0 });
      } else {
        const r = recallAt(st, at);
        states.set(c.t.id, { ...st, halfLife: st.halfLife * growthFactor(c.t.difficulty, r, reviewScore, p), lastReviewAt: at, nReviews: st.nReviews + 1 });
        tasks.push({ day, subjectId: c.s.id, topicId: c.t.id, kind: 'review', minutes, marksGain: c.gain });
      }
      doneToday.add(c.t.id);
      budget -= minutes;
    };

    // What-if: tasks the user moved onto this day go first.
    for (const id of forced.get(day) ?? []) {
      const c = candidates().find(x => x.t.id === id) ?? (() => {
        // A review the user wants even if not "due" yet.
        for (const s of subjects) for (const t of s.topics) if (t.id === id && states.get(id)!.lastReviewAt != null && s.examAt > at) {
          const cost = Math.min(25, Math.max(8, Math.round(t.estLearnMin * 0.2)));
          return { s, t, kind: 'review' as const, cost, gain: 0, value: 0 };
        }
        return undefined;
      })();
      if (c) apply(c, Math.min(c.cost, Math.max(budget, 0)) || c.cost);
    }

    while (budget >= 8) {
      const list = candidates().filter(c => c.gain > 0.001).sort((a, b) => b.value - a.value);
      if (!list.length) break;
      const c = list[0];
      const minutes = c.kind === 'learn' ? Math.min(c.cost, budget) : c.cost;
      if (minutes > budget) {
        // Best review doesn't fit; try the best one that does.
        const fit = list.find(x => (x.kind === 'learn' ? Math.min(x.cost, budget) : x.cost) <= budget);
        if (!fit) break;
        apply(fit, fit.kind === 'learn' ? Math.min(fit.cost, budget) : fit.cost);
      } else apply(c, minutes);
    }
  }

  const forecasts = subjects.map(s => forecastSubject(s, states));
  return { tasks, states, forecasts };
}

// Small seeded RNG so the forecast doesn't jump around between page loads.
function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gaussian(rand: () => number) {
  const u = Math.max(rand(), 1e-9), v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export function forecastSubject(s: SubjectInput, states: Map<number, MemoryState>, runs = 1000): SubjectForecast {
  const rand = mulberry32(s.id * 7919 + 17);
  const topics = s.topics.map(t => {
    const st = states.get(t.id) ?? t.state;
    return {
      id: t.id, title: t.title, marks: marksOf(s, t),
      expected: expectedOnExam(st, s.examAt, s.guessRate),
      recallOnExam: st.lastReviewAt == null ? 0 : recallAt(st, s.examAt),
      st,
    };
  });
  const totals: number[] = [];
  for (let r = 0; r < runs; r++) {
    let total = 0;
    for (const t of topics) {
      let e = s.guessRate;
      if (t.st.lastReviewAt != null) {
        const h = t.st.halfLife * Math.exp(gaussian(rand) * t.st.hlUncertainty);
        e = Math.max(s.guessRate, t.st.mastery * recall(h, (s.examAt - t.st.lastReviewAt) / DAY));
      }
      const n = Math.max(1, Math.round(t.marks / 4));
      let k = 0;
      for (let i = 0; i < n; i++) if (rand() < e) k++;
      total += (k / n) * t.marks;
    }
    totals.push(total);
  }
  totals.sort((a, b) => a - b);
  const q = (f: number) => Math.round(totals[Math.min(totals.length - 1, Math.floor(f * totals.length))]);
  const base = new Map(s.topics.map(t => [t.id, t.state]));
  return {
    subjectId: s.id,
    readiness: readinessOf(s, states),
    readinessIfStopNow: readinessOf(s, base),
    scoreP10: q(0.1), scoreP50: q(0.5), scoreP90: q(0.9),
    totalMarks: s.totalMarks,
    topics: topics.map(({ st, ...t }) => t),
  };
}

export interface TriageItem {
  topicId: number;
  title: string;
  kind: 'learn' | 'review';
  hours: number;
  marksGain: number;
  marksPerHour: number;
  decision: 'do' | 'skip';
}

export interface TriageResult {
  active: boolean;
  requiredMinutes: number;
  availableMinutes: number;
  items: TriageItem[];
  skippedMarks: number;
}

/** Triage: if the time you need is more than the time you have, rank by marks per hour and say what to skip. */
export function triage(s: SubjectInput, now: number, dailyMinutes: number, params: UserParams = DEFAULT_PARAMS): TriageResult {
  const days = Math.max(0, Math.floor((s.examAt - startOfDay(now)) / DAY));
  const availableMinutes = days * dailyMinutes;
  const at = now;
  const items: TriageItem[] = [];
  for (const t of s.topics) {
    const st = t.state;
    const marks = marksOf(s, t);
    const before = expectedOnExam(st, s.examAt, s.guessRate);
    let kind: 'learn' | 'review', minutes: number, after: MemoryState;
    if (st.lastReviewAt == null) {
      kind = 'learn'; minutes = t.estLearnMin;
      // Learned now and reviewed ~twice before the exam.
      after = { ...initialState(t.difficulty, params), mastery: 0.78, lastReviewAt: Math.max(at, s.examAt - 2 * DAY), nReviews: 3 };
      minutes += 2 * Math.min(25, Math.max(8, Math.round(t.estLearnMin * 0.2)));
    } else {
      kind = 'review'; minutes = 2 * Math.min(25, Math.max(8, Math.round(t.estLearnMin * 0.2)));
      after = { ...st, lastReviewAt: Math.max(at, s.examAt - 1.5 * DAY), halfLife: st.halfLife * 1.6 };
    }
    const gain = Math.max(0, marks * (expectedOnExam(after, s.examAt, s.guessRate) - before));
    items.push({ topicId: t.id, title: t.title, kind, hours: minutes / 60, marksGain: gain, marksPerHour: gain / (minutes / 60), decision: 'skip' });
  }
  items.sort((a, b) => b.marksPerHour - a.marksPerHour);
  const requiredMinutes = items.filter(i => i.marksGain > 0.2).reduce((a, i) => a + i.hours * 60, 0);
  let left = availableMinutes;
  for (const i of items) {
    if (i.marksGain <= 0.2) { i.decision = 'do'; continue; } // nothing to gain = already safe
    if (i.hours * 60 <= left) { i.decision = 'do'; left -= i.hours * 60; }
  }
  const skippedMarks = items.filter(i => i.decision === 'skip').reduce((a, i) => a + i.marksGain, 0);
  return { active: requiredMinutes > availableMinutes * 0.9, requiredMinutes, availableMinutes, items, skippedMarks };
}
