// Calibration (dangerous topics), confusion pairs and study patterns.

export interface AttemptLite {
  topicId: number;
  confidence: number; // 1..5
  correct: boolean;
  answeredAt: number;
}

export interface Calibration {
  topicId: number;
  n: number;
  expectedPct: number;  // what your confidence said
  accuracyPct: number;  // what you actually scored
  gap: number;          // expected - accuracy, in points
  dangerous: boolean;
}

export const confidenceToPct = (c: number) => Math.min(5, Math.max(1, c)) * 20;

export function calibrationByTopic(attempts: AttemptLite[], window = 20): Calibration[] {
  const by = new Map<number, AttemptLite[]>();
  for (const a of attempts) by.set(a.topicId, [...(by.get(a.topicId) ?? []), a]);
  const out: Calibration[] = [];
  for (const [topicId, list] of by) {
    const recent = list.sort((a, b) => b.answeredAt - a.answeredAt).slice(0, window);
    const n = recent.length;
    const expectedPct = recent.reduce((s, a) => s + confidenceToPct(a.confidence), 0) / n;
    const accuracyPct = (recent.filter(a => a.correct).length / n) * 100;
    const gap = expectedPct - accuracyPct;
    out.push({ topicId, n, expectedPct, accuracyPct, gap, dangerous: n >= 5 && gap >= 20 });
  }
  return out;
}

/** Brier score: 0 = you know exactly what you know, 0.25 = coin flip. */
export function brier(attempts: AttemptLite[]): number {
  if (!attempts.length) return 0;
  return attempts.reduce((s, a) => s + (confidenceToPct(a.confidence) / 100 - (a.correct ? 1 : 0)) ** 2, 0) / attempts.length;
}

export interface ConfusionRow { topicA: number; topicB: number; count: number; exposures: number }

export const activeConfusions = (rows: ConfusionRow[]) =>
  rows.filter(r => r.count >= 3 && r.count / Math.max(1, r.exposures) >= 0.3)
    .sort((a, b) => b.count - a.count);

export interface PatternSample {
  bucket: string;   // e.g. "late night", "morning"
  halfLife: number; // topic half-life after studying in this bucket
}

export interface PatternFinding {
  a: string; b: string;
  ratio: number;    // median half-life of a / of b
  nA: number; nB: number;
}

const median = (xs: number[]) => {
  const s = [...xs].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Compares buckets; only reports a difference that holds up in a bootstrap (90% interval excludes "no difference"). */
export function findPatterns(samples: PatternSample[], minPerBucket = 8, seed = 42): PatternFinding[] {
  let x = seed;
  const rand = () => { x = (x * 1664525 + 1013904223) % 4294967296; return x / 4294967296; };
  const by = new Map<string, number[]>();
  for (const s of samples) by.set(s.bucket, [...(by.get(s.bucket) ?? []), s.halfLife]);
  const buckets = [...by.entries()].filter(([, v]) => v.length >= minPerBucket);
  const out: PatternFinding[] = [];
  for (let i = 0; i < buckets.length; i++) for (let j = i + 1; j < buckets.length; j++) {
    const [a, va] = buckets[i], [b, vb] = buckets[j];
    const ratios: number[] = [];
    for (let k = 0; k < 400; k++) {
      const ra = va.map(() => va[Math.floor(rand() * va.length)]);
      const rb = vb.map(() => vb[Math.floor(rand() * vb.length)]);
      ratios.push(median(ra) / median(rb));
    }
    ratios.sort((p, q) => p - q);
    const lo = ratios[Math.floor(0.05 * ratios.length)], hi = ratios[Math.floor(0.95 * ratios.length)];
    if (lo > 1 || hi < 1) out.push({ a, b, ratio: median(va) / median(vb), nA: va.length, nB: vb.length });
  }
  return out;
}

export function hourBucket(hour: number): string {
  if (hour >= 5 && hour < 12) return 'morning';
  if (hour >= 12 && hour < 17) return 'afternoon';
  if (hour >= 17 && hour < 23) return 'evening';
  return 'late night';
}
