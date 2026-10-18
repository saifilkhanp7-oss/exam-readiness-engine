import { useEffect, useMemo, useState } from 'react';
import { simulatePlan, startOfDay, DAY, type SubjectInput, type UserParams } from '@ere/engine';
import { ArrowRight, RotateCcw } from 'lucide-react';
import { api } from '../api.ts';
import { useAuth } from '../App.tsx';
import { Button, Card, Empty, PageTitle, conditions } from '../ui.tsx';

interface Input { subjects: SubjectInput[]; dailyMinutes: number; params: UserParams; now: number }
type Move = { topicId: number; fromDay: number; toDay: number };

const dayName = (ts: number) => {
  const today = startOfDay(Date.now());
  if (ts === today) return 'Today';
  if (ts === today + DAY) return 'Tomorrow';
  return new Date(ts).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short' });
};
const hm = (m: number) => (m >= 60 ? `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}` : `${m} min`);

export default function Plan() {
  const { user, setUser } = useAuth();
  const [input, setInput] = useState<Input | null>(null);
  const [minutes, setMinutes] = useState(90);
  const [moves, setMoves] = useState<Move[]>([]);
  useEffect(() => { api<Input>('/simulate-input').then(r => { setInput(r); setMinutes(r.dailyMinutes); }); }, []);

  const base = useMemo(() => input && simulatePlan(input.subjects, { now: input.now, dailyMinutes: input.dailyMinutes, params: input.params }), [input]);
  const what = useMemo(() => input && simulatePlan(input.subjects, { now: input.now, dailyMinutes: minutes, params: input.params, movedTasks: moves }), [input, minutes, moves]);

  if (!input || !base || !what) return <p className="text-ink-soft">Building your plan…</p>;
  if (!input.subjects.length) return <div><PageTitle title="Plan" /><Empty title="No upcoming exams">Add subjects with exam dates to get a plan.</Empty></div>;

  const titles = new Map<number, { title: string; color: string; subject: string }>();
  for (const s of input.subjects) for (const t of s.topics) titles.set(t.id, { title: t.title, color: '', subject: s.name });
  const changed = minutes !== input.dailyMinutes || moves.length > 0;
  const today = startOfDay(Date.now());
  const days = Array.from({ length: 7 }, (_, k) => today + k * DAY);
  const tasksByDay = (day: number) => what.tasks.filter(t => t.day === day);

  async function saveMinutes() {
    const r = await api<{ user: any }>('/me', { method: 'PATCH', body: { daily_minutes: minutes } });
    setUser(r.user);
    setInput(i => i && { ...i, dailyMinutes: minutes });
  }

  return (
    <div>
      <PageTitle title="Plan and what-if" sub="Your revision fitted into your daily study time. Move the slider or a session to see how exam day changes." />

      <Card className="p-5 md:p-6 mb-8">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
          <label htmlFor="mins" className="font-bold">Study time per day</label>
          <input id="mins" type="range" min={20} max={360} step={10} value={minutes} onChange={e => setMinutes(Number(e.target.value))} className="flex-1 min-w-[180px] accent-[var(--color-act)]" />
          <span className="font-display text-2xl font-extrabold tabular-nums w-28 text-right">{hm(minutes)}</span>
        </div>
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4 mt-6">
          {input.subjects.map(s => {
            const a = base.forecasts.find(f => f.subjectId === s.id)!;
            const b = what.forecasts.find(f => f.subjectId === s.id)!;
            const diff = b.readiness - a.readiness;
            const c = conditions(b.readiness);
            return (
              <div key={s.id} className="rounded-xl bg-paper p-4">
                <p className="font-bold">{s.name}</p>
                <div className="flex items-baseline gap-2 mt-1">
                  <span className="font-display text-xl text-ink-soft tabular-nums">{Math.round(a.readiness)}%</span>
                  {changed && <><ArrowRight size={16} className="text-ink-soft self-center" />
                    <span className="font-display text-3xl font-extrabold tabular-nums" style={{ color: c.tone }}>{Math.round(b.readiness)}%</span>
                    <span className={`text-sm font-bold ${diff >= 0 ? 'text-clear' : 'text-storm'}`}>{diff >= 0 ? '+' : ''}{diff.toFixed(1)}</span></>}
                </div>
                <p className="text-sm text-ink-soft mt-1">Score {changed ? `${b.scoreP10}–${b.scoreP90}` : `${a.scoreP10}–${a.scoreP90}`} of {s.totalMarks}</p>
              </div>
            );
          })}
        </div>
        {changed && (
          <div className="flex flex-wrap gap-2 mt-5">
            {minutes !== input.dailyMinutes && <Button onClick={saveMinutes}>Use {hm(minutes)} a day</Button>}
            <Button variant="ghost" onClick={() => { setMinutes(input.dailyMinutes); setMoves([]); }}><RotateCcw size={15} /> Reset</Button>
          </div>
        )}
        <p className="text-xs text-ink-soft mt-4">Currently planning {hm(user?.daily_minutes ?? input.dailyMinutes)} a day.</p>
      </Card>

      <h2 className="text-xl font-bold mb-3">Next 7 days</h2>
      <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-4">
        {days.map(day => {
          const list = tasksByDay(day);
          const total = list.reduce((a, t) => a + t.minutes, 0);
          return (
            <Card key={day} className="p-4">
              <div className="flex justify-between items-baseline mb-2">
                <p className="font-bold">{dayName(day)}</p>
                <p className="text-sm text-ink-soft tabular-nums">{hm(total)}</p>
              </div>
              {!list.length ? <p className="text-sm text-ink-soft py-2">Free day</p> : (
                <ul className="grid gap-2">
                  {list.map((t, k) => {
                    const info = titles.get(t.topicId);
                    return (
                      <li key={k} className="rounded-lg bg-paper px-3 py-2">
                        <div className="flex justify-between gap-2">
                          <span className="text-sm font-bold">{info?.title}</span>
                          <span className="text-xs text-ink-soft tabular-nums shrink-0">{t.minutes} min</span>
                        </div>
                        <div className="flex justify-between items-center gap-2 mt-1">
                          <span className="text-xs text-ink-soft">{t.kind === 'learn' ? 'Learn' : 'Review'} in {info?.subject}</span>
                          {t.kind === 'review' && (
                            <select aria-label="Move to another day" value="" className="text-xs bg-transparent text-act font-bold"
                              onChange={e => setMoves(m => [...m.filter(x => !(x.topicId === t.topicId && x.fromDay === day)), { topicId: t.topicId, fromDay: day, toDay: Number(e.target.value) }])}>
                              <option value="" disabled>Move to…</option>
                              {days.filter(x => x !== day).map(x => <option key={x} value={x}>{dayName(x)}</option>)}
                            </select>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </Card>
          );
        })}
      </div>
    </div>
  );
}
