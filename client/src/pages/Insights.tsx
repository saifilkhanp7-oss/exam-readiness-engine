import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, Shuffle, TrendingDown, Clock, Scissors } from 'lucide-react';
import { api } from '../api.ts';
import { Button, Card, Empty, PageTitle } from '../ui.tsx';

interface Data {
  insights: { kind: string; text: string }[];
  calibration: { topicId: number; title: string; n: number; expectedPct: number; accuracyPct: number; gap: number; dangerous: boolean }[];
  confusions: { topicA: number; topicB: number; a: string; b: string; count: number; exposures: number }[];
  brier: number;
}
function CalibrationPlot({ points }: { points: Data['calibration'] }) {
  const W = 520, H = 340, L = 46, B = 40, T = 12, R = 16;
  const x = (v: number) => L + (v / 100) * (W - L - R);
  const y = (v: number) => H - B - (v / 100) * (H - B - T);
  const [hover, setHover] = useState<Data['calibration'][number] | null>(null);
  return (
    <div className="relative mt-4">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Confidence compared with score for each topic">
        <polygon points={`${x(0)},${y(0)} ${x(100)},${y(0)} ${x(100)},${y(100)}`} fill="var(--color-storm-soft)" opacity="0.55" />
        {[0, 25, 50, 75, 100].map(v => (
          <g key={v}>
            <line x1={x(0)} x2={x(100)} y1={y(v)} y2={y(v)} stroke="var(--color-mist)" />
            <text x={L - 8} y={y(v) + 4} textAnchor="end" fontSize="11" fill="var(--color-ink-soft)">{v}%</text>
            <text x={x(v)} y={H - B + 18} textAnchor="middle" fontSize="11" fill="var(--color-ink-soft)">{v}%</text>
          </g>
        ))}
        <line x1={x(0)} y1={y(0)} x2={x(100)} y2={y(100)} stroke="var(--color-mist-deep)" strokeDasharray="5 5" />
        <text x={x(97)} y={y(8)} textAnchor="end" fontSize="12" fill="var(--color-storm)">Feel sure, score low</text>
        <text x={(L + W - R) / 2} y={H - 4} textAnchor="middle" fontSize="12" fill="var(--color-ink-soft)">How sure you felt</text>
        <text transform={`translate(12 ${(H - B) / 2}) rotate(-90)`} textAnchor="middle" fontSize="12" fill="var(--color-ink-soft)">Score</text>
        {points.map(c => (
          <circle key={c.topicId} cx={x(c.expectedPct)} cy={y(c.accuracyPct)} r={c.dangerous ? 8 : 6}
            fill={c.dangerous ? 'var(--color-storm)' : c.gap > 10 ? 'var(--color-haze)' : 'var(--color-clear)'} stroke="var(--color-card)" strokeWidth="2"
            onMouseEnter={() => setHover(c)} onMouseLeave={() => setHover(null)}>
            <title>{`${c.title}: felt ${Math.round(c.expectedPct)}%, scored ${Math.round(c.accuracyPct)}%`}</title>
          </circle>
        ))}
        {points.filter(c => c.dangerous).map(c => (
          <text key={`l${c.topicId}`} x={x(c.expectedPct)} y={y(c.accuracyPct) + 24} textAnchor={c.expectedPct > 75 ? 'end' : 'middle'} fontSize="12" fontWeight="600" fill="var(--color-ink)">{c.title.length > 24 ? c.title.slice(0, 23) + '…' : c.title}</text>
        ))}
      </svg>
      {hover && <p className="absolute top-0 right-0 bg-card border border-mist rounded-lg px-3 py-1.5 text-sm shadow-sm">{hover.title}: felt {Math.round(hover.expectedPct)}%, scored {Math.round(hover.accuracyPct)}%</p>}
    </div>
  );
}

const ICON: Record<string, typeof Clock> = { danger: AlertTriangle, confusion: Shuffle, fade: TrendingDown, pattern: Clock, triage: Scissors };

type Model =
  | { fitted: false; answers: number; needed: number }
  | { fitted: true; answers: number; fittedOn: number; fittedAt: number; growth: number; defaultGrowth: number; userPrior: number; contextMult: Record<string, number>; improvement: number };

/** What the personal memory model has learned, in plain words. */
function PersonalModel({ m, onRefit }: { m: Model; onRefit: () => void }) {
  if (!m.fitted) {
    const pct = Math.min(100, (m.answers / m.needed) * 100);
    return (
      <Card className="p-5 md:p-6 mb-10">
        <h2 className="text-xl font-bold">Your personal memory model</h2>
        <p className="text-ink-soft mt-1">Right now forecasts use a standard formula. After {m.needed} quiz answers the app fits the formula to your own memory.</p>
        <div className="mt-4 h-2.5 rounded-full bg-mist overflow-hidden"><div className="h-full bg-act rounded-full" style={{ width: `${pct}%` }} /></div>
        <p className="text-sm text-ink-soft mt-2 tabular-nums">{m.answers} of {m.needed} answers</p>
      </Card>
    );
  }
  const growthWord = m.growth >= m.defaultGrowth * 1.1 ? 'more than' : m.growth <= m.defaultGrowth * 0.9 ? 'less than' : 'about as much as';
  return (
    <Card className="p-5 md:p-6 mb-10">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold">Your personal memory model</h2>
          <p className="text-ink-soft mt-1">Fitted to your {m.fittedOn} answers on {new Date(m.fittedAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}. It refits after every 50 new answers.</p>
        </div>
        <Button variant="soft" onClick={onRefit}>Refit now</Button>
      </div>
      <div className="grid sm:grid-cols-3 gap-4 mt-5">
        <div className="rounded-xl bg-paper p-4">
          <p className="font-display text-3xl font-extrabold text-clear">{Math.round(m.improvement * 100)}%</p>
          <p className="text-sm text-ink-soft mt-1">better at predicting your quiz results than the standard formula</p>
        </div>
        <div className="rounded-xl bg-paper p-4">
          <p className="font-display text-3xl font-extrabold">{m.userPrior.toFixed(1)}×</p>
          <p className="text-sm text-ink-soft mt-1">how long a new topic lasts for you, compared with the standard first guess</p>
        </div>
        <div className="rounded-xl bg-paper p-4">
          <p className="font-display text-3xl font-extrabold">{(m.growth / m.defaultGrowth).toFixed(2)}×</p>
          <p className="text-sm text-ink-soft mt-1">a good review strengthens your memory {growthWord} the average student</p>
        </div>
      </div>
      <p className="text-sm text-ink-soft mt-4">Forecasts, review dates and the plan all use these personal values now. Time-of-day patterns appear in the list above once the difference is clear.</p>
    </Card>
  );
}

export default function Insights() {
  const [d, setD] = useState<Data | null>(null);
  const [model, setModel] = useState<Model | null>(null);
  useEffect(() => { api<Data>('/insights').then(setD); api<Model>('/model').then(setModel).catch(() => {}); }, []);
  const refit = async () => { setModel(await api<Model>('/model/refit', { body: {} })); api<Data>('/insights').then(setD); };
  if (!d) return <p className="text-ink-soft">Loading…</p>;
  const seen = new Set<string>();
  const pairs = d.confusions.filter(c => { const k = [c.topicA, c.topicB].sort().join(); if (seen.has(k)) return false; seen.add(k); return true; });
  const calib = d.calibration.filter(c => c.n >= 3);

  return (
    <div>
      <PageTitle title="Insights" sub="What the app has learned about how you remember." />

      <div className="grid gap-3 mb-10 max-w-3xl">
        {d.insights.length ? d.insights.map((it, i) => {
          const Icon = ICON[it.kind] ?? Clock;
          return (
            <Card key={i} className="p-4 flex gap-3 items-start">
              <Icon size={19} className={`shrink-0 mt-0.5 ${it.kind === 'danger' ? 'text-storm' : it.kind === 'confusion' ? 'text-haze' : 'text-act'}`} />
              <p className="leading-relaxed">{it.text}</p>
            </Card>
          );
        }) : <Empty title="Not enough data yet">After a few days of quizzes, patterns about your memory show up here.</Empty>}
      </div>

      {model && <PersonalModel m={model} onRefit={refit} />}

      <div className="grid lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)] gap-6">
        <Card className="p-5 md:p-6">
          <h2 className="text-xl font-bold">How sure you feel vs how you score</h2>
          <p className="text-sm text-ink-soft mt-1">Dots below the line are topics where you feel better than you score. Those are the dangerous ones.</p>
          {calib.length ? <CalibrationPlot points={calib} /> : <p className="text-ink-soft mt-4">Answer at least 3 questions per topic to see this.</p>}
          {calib.length > 0 && (() => {
            const n = calib.reduce((a, c) => a + c.n, 0);
            const score = Math.round(100 - calib.reduce((a, c) => a + Math.abs(c.gap) * c.n, 0) / n);
            return <p className="text-sm text-ink-soft mt-2">Self-knowledge score: <b className="text-ink">{score}/100</b>. 100 means how sure you feel always matches how you score.</p>;
          })()}
        </Card>

        <Card className="p-5 md:p-6">
          <h2 className="text-xl font-bold">Topics you mix up</h2>
          <p className="text-sm text-ink-soft mt-1">Found from the wrong answers you picked.</p>
          {pairs.length ? (
            <ul className="mt-4 grid gap-3">
              {pairs.map(p => (
                <li key={`${p.topicA}-${p.topicB}`} className="rounded-xl bg-paper p-4">
                  <p className="font-bold">{p.a} <span className="text-ink-soft font-normal">and</span> {p.b}</p>
                  <p className="text-sm text-ink-soft mt-0.5">Mixed up {p.count} times out of {p.exposures} chances</p>
                  <Link to={`/quiz?mode=contrast&a=${p.topicA}&b=${p.topicB}`}><Button variant="soft" className="mt-3 py-2">Tell them apart quiz</Button></Link>
                </li>
              ))}
            </ul>
          ) : <p className="text-ink-soft mt-4">No mix-ups found yet.</p>}
        </Card>
      </div>
    </div>
  );
}
