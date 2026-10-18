import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { LineChart, Line, ResponsiveContainer, YAxis, Tooltip } from 'recharts';
import { AlertTriangle, Shuffle, TrendingDown, Clock, Scissors, Plus } from 'lucide-react';
import { api, type Subject } from '../api.ts';
import { useAuth } from '../App.tsx';
import { Button, Card, Empty, conditions, daysUntil, fmtDate } from '../ui.tsx';

interface F { subjectId: number; readiness: number; readinessIfStopNow: number; scoreP10: number; scoreP50: number; scoreP90: number; totalMarks: number }
interface Data {
  subjects: Subject[]; forecasts: F[];
  history: { subject_id: number; day: string; readiness: number }[];
  tasks: { day: number; subjectId: number; topicId: number; kind: string; minutes: number; marksGain: number; title: string }[];
  insights: { kind: string; text: string }[];
  dailyMinutes: number;
}

const ICON: Record<string, typeof AlertTriangle> = { danger: AlertTriangle, confusion: Shuffle, fade: TrendingDown, pattern: Clock, triage: Scissors };


function ScoreBand({ f, color }: { f: F; color: string }) {
  const L = (v: number) => `${(v / f.totalMarks) * 100}%`;
  return (
    <div className="w-full">
      <div className="relative h-2.5 rounded-full bg-mist">
        <div className="absolute inset-y-0 rounded-full opacity-35" style={{ left: L(f.scoreP10), width: `calc(${L(f.scoreP90)} - ${L(f.scoreP10)})`, background: color }} />
        <div className="absolute -top-1 h-4.5 w-1 rounded-full" style={{ left: `calc(${L(f.scoreP50)} - 2px)`, background: color }} />
      </div>
      <div className="flex justify-between text-xs text-ink-soft mt-1.5 tabular-nums">
        <span>0</span>
        <span>Likely score <b className="text-ink">{f.scoreP10}–{f.scoreP90}</b> of {f.totalMarks}</span>
        <span>{f.totalMarks}</span>
      </div>
    </div>
  );
}

export default function Forecast() {
  const { user } = useAuth();
  const [d, setD] = useState<Data | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => { api<Data>('/forecast').then(setD).catch(e => setErr(e.message)); }, []);

  if (err) return <p className="text-storm">{err}</p>;
  if (!d) return <p className="text-ink-soft">Loading forecast…</p>;

  const today = new Date(); today.setHours(0, 0, 0, 0);
  const todayTasks = d.tasks.filter(t => t.day === today.getTime());
  const subjectById = new Map(d.subjects.map(s => [s.id, s]));
  const upcoming = d.subjects.filter(s => s.exam_at > Date.now());
  const hello = new Date().getHours() < 12 ? 'Good morning' : new Date().getHours() < 17 ? 'Good afternoon' : 'Good evening';

  return (
    <div>
      <header className="mb-8">
        <p className="text-ink-soft">{hello}, {user?.username.split(' ')[0]}</p>
        <h1 className="text-3xl md:text-4xl font-extrabold mt-1">Exam-day forecast</h1>
        <p className="text-ink-soft mt-1">If you follow today's plan ({d.dailyMinutes} min a day). Updates every day.</p>
      </header>

      {!upcoming.length ? (
        <Empty title="No exams yet">
          <p>Add your subjects and exam dates to see your first forecast.</p>
          <Link to="/subjects"><Button className="mt-4"><Plus size={16} /> Add subjects</Button></Link>
        </Empty>
      ) : (
        <div className="grid gap-4">
          {upcoming.map(s => {
            const f = d.forecasts.find(x => x.subjectId === s.id);
            if (!f) return null;
            const c = conditions(f.readiness);
            const hist = d.history.filter(h => h.subject_id === s.id).slice(-14);
            const prev = hist.length > 1 ? hist[hist.length - 2].readiness : null;
            const delta = prev == null ? null : f.readiness - prev;
            return (
              <Card key={s.id} className="p-5 md:p-6">
                <div className="grid lg:grid-cols-[190px_minmax(0,1fr)_170px] gap-5 lg:gap-8 items-center">
                  <Link to={`/subjects/${s.id}`} className="group">
                    <div className="flex items-center gap-2">
                      <span className="w-2.5 h-2.5 rounded-full" style={{ background: s.color }} />
                      <h2 className="text-xl font-bold group-hover:text-act">{s.name}</h2>
                    </div>
                    <p className="text-sm text-ink-soft mt-1">{fmtDate(s.exam_at)}, in {daysUntil(s.exam_at)} days</p>
                  </Link>
                  <div className="flex flex-col sm:flex-row sm:items-center gap-4 sm:gap-6">
                    <div className="shrink-0">
                      <p className="font-display text-5xl font-extrabold tabular-nums leading-none" style={{ color: c.tone }}>{Math.round(f.readiness)}<span className="text-2xl">%</span></p>
                      <p className="text-sm font-bold mt-1.5" style={{ color: c.tone }}>{c.word}
                        {delta != null && Math.abs(delta) >= 0.5 && <span className="text-ink-soft font-normal">, {delta > 0 ? 'up' : 'down'} {Math.abs(delta).toFixed(0)} since yesterday</span>}
                      </p>
                    </div>
                    <div className="flex-1 min-w-0 w-full"><ScoreBand f={f} color={c.tone} /></div>
                  </div>
                  <div className="h-14 hidden lg:block" aria-label="Readiness over the last two weeks">
                    {hist.length > 1 && window.matchMedia('(min-width: 1024px)').matches && (
                      <ResponsiveContainer width="100%" height="100%">
                        <LineChart data={hist}>
                          <YAxis hide domain={[0, 100]} />
                          <Tooltip formatter={(v: number) => [`${Math.round(v)}%`, 'Readiness']} labelFormatter={(_, p) => p?.[0]?.payload?.day} />
                          <Line dataKey="readiness" stroke={c.tone} strokeWidth={2.5} dot={false} isAnimationActive={false} />
                        </LineChart>
                      </ResponsiveContainer>
                    )}
                    <p className="text-[11px] text-ink-soft text-right">last 14 days</p>
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      <div className="grid lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] gap-6 mt-10">
        <section>
          <div className="flex items-baseline justify-between mb-3">
            <h2 className="text-xl font-bold">Today's plan</h2>
            <Link to="/plan" className="text-sm font-bold text-act">Whole week</Link>
          </div>
          {todayTasks.length ? (
            <Card className="divide-y divide-mist">
              {todayTasks.map((t, i) => {
                const s = subjectById.get(t.subjectId);
                return (
                  <div key={i} className="flex items-center gap-3 px-5 py-3.5">
                    <span className="w-1 self-stretch rounded-full" style={{ background: s?.color }} />
                    <div className="flex-1 min-w-0">
                      <p className="font-bold truncate">{t.title}</p>
                      <p className="text-sm text-ink-soft">{t.kind === 'learn' ? 'Learn' : 'Review'} in {s?.name}</p>
                    </div>
                    <div className="text-right text-sm">
                      <p className="tabular-nums font-bold">{t.minutes} min</p>
                      {t.marksGain > 0.05 && <p className="text-clear text-xs">+{t.marksGain.toFixed(1)} marks</p>}
                    </div>
                  </div>
                );
              })}
            </Card>
          ) : <Empty title="Nothing planned today">You're up to date. A short quiz keeps your forecast accurate.</Empty>}
          <Link to="/quiz"><Button className="mt-4 w-full sm:w-auto">Start today's quiz</Button></Link>
        </section>

        <section>
          <h2 className="text-xl font-bold mb-3">What your memory is telling you</h2>
          {d.insights.length ? (
            <div className="grid gap-3">
              {d.insights.map((it, i) => {
                const Icon = ICON[it.kind] ?? Clock;
                const tone = it.kind === 'danger' ? 'text-storm bg-storm-soft' : it.kind === 'confusion' ? 'text-haze bg-haze-soft' : 'text-act bg-act-soft';
                return (
                  <div key={i} className="flex gap-3 items-start">
                    <span className={`shrink-0 grid place-items-center w-9 h-9 rounded-xl ${tone}`}><Icon size={17} /></span>
                    <p className="leading-relaxed pt-1.5">{it.text}</p>
                  </div>
                );
              })}
            </div>
          ) : <p className="text-ink-soft">Take a few quizzes and insights about your memory will show up here.</p>}
        </section>
      </div>
    </div>
  );
}
