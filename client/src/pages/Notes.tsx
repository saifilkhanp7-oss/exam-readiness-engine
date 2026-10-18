import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Printer, AlertTriangle, Shuffle, RotateCw, Moon } from 'lucide-react';
import { api, type Subject } from '../api.ts';
import { Button, Card, Empty, Formula, Markdown, PageTitle, RecallBar, fmtDate, pct, recallColor } from '../ui.tsx';

interface Note {
  id: number; title: string; chapter: string | null; level: 'line' | 'compact' | 'detailed'; danger: boolean;
  recall_on_exam: number; recall_now: number; recall_tomorrow: number; studied: boolean;
  line: string | null; compact: string | null; detailed: string | null; simple: string | null; page_from: number | null; page_to: number | null;
}
interface FormulaRow { id: number; name: string; latex: string; meaning: string | null; topic: string; topicId: number; recall_on_exam: number; recall_tomorrow: number; studied: boolean }
interface Data {
  subject: Subject; notes: Note[]; formulas: FormulaRow[];
  lastNight: { at: number; topics: Note[]; formulas: FormulaRow[] };
  confusionPairs: { topicA: number; topicB: number; count: number }[];
}

const TABS = [
  { id: 'smart', label: 'Smart notes' },
  { id: 'cheat', label: 'Cheat sheet' },
  { id: 'map', label: 'Mind map' },
  { id: 'cards', label: 'Flashcards' },
  { id: 'chapters', label: 'Simple chapters' },
  { id: 'formulas', label: 'Formula sheet' },
  { id: 'night', label: 'Last night sheet' },
] as const;
type Tab = typeof TABS[number]['id'];

const WHY: Record<Note['level'], string> = {
  detailed: 'Full notes: you are likely to forget this',
  compact: 'Short notes: fading a little',
  line: 'One line: you know this well',
};

function SmartNotes({ d }: { d: Data }) {
  const [open, setOpen] = useState<Record<number, boolean>>({});
  const byId = new Map(d.notes.map(n => [n.id, n]));
  const pairs = d.confusionPairs.filter((p, i, a) => a.findIndex(q => [q.topicA, q.topicB].sort().join() === [p.topicA, p.topicB].sort().join()) === i);
  return (
    <div className="grid gap-4">
      {pairs.map(p => {
        const a = byId.get(p.topicA), b = byId.get(p.topicB);
        if (!a || !b) return null;
        return (
          <Card key={`${p.topicA}-${p.topicB}`} className="p-5 border-haze/50 bg-haze-soft">
            <p className="font-bold flex items-center gap-2"><Shuffle size={17} className="text-haze" /> You mix up {a.title} and {b.title}</p>
            <div className="grid sm:grid-cols-2 gap-4 mt-3">
              {[a, b].map(n => (
                <div key={n.id} className="rounded-xl bg-card border border-mist p-4">
                  <p className="font-display font-bold mb-1">{n.title}</p>
                  <p className="text-sm leading-relaxed">{n.line}</p>
                </div>
              ))}
            </div>
            <Link to={`/quiz?mode=contrast&a=${a.id}&b=${b.id}`}><Button variant="soft" className="mt-3">Practise telling them apart</Button></Link>
          </Card>
        );
      })}
      {d.notes.map(n => {
        const level = open[n.id] ? 'detailed' : n.level;
        return (
          <Card key={n.id} className="p-5 md:p-6">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h3 className="text-lg font-bold flex items-center gap-2">
                  {n.title}
                  {n.danger && <span className="inline-flex items-center gap-1 rounded-full bg-storm-soft text-storm text-[11px] px-2 py-0.5 font-sans"><AlertTriangle size={11} /> Risky</span>}
                </h3>
                <p className="text-xs text-ink-soft mt-0.5">{n.danger ? 'Full notes: you feel sure but score low' : !n.studied ? 'Full notes: not studied yet' : WHY[n.level]}{n.page_from ? `, pages ${n.page_from}–${n.page_to}` : ''}</p>
              </div>
              {n.studied && <RecallBar value={n.recall_on_exam} width="w-32" label="Predicted recall on exam day" />}
            </div>
            <div className="mt-3 leading-relaxed">
              {level === 'line' && <p>{n.line}</p>}
              {level === 'compact' && <Markdown text={n.compact} />}
              {level === 'detailed' && <Markdown text={n.detailed} />}
            </div>
            {n.level !== 'detailed' && (
              <button onClick={() => setOpen(o => ({ ...o, [n.id]: !o[n.id] }))} className="text-sm font-bold text-act mt-3">
                {open[n.id] ? 'Show less' : 'Show full notes'}
              </button>
            )}
          </Card>
        );
      })}
    </div>
  );
}

function CheatSheet({ d }: { d: Data }) {
  return (
    <Card className="p-5 md:p-7">
      <div className="flex items-baseline justify-between mb-4">
        <h2 className="text-xl font-bold">{d.subject.name} cheat sheet</h2>
        <span className="text-sm text-ink-soft">Weakest topics get more space</span>
      </div>
      <div className="columns-1 md:columns-2 xl:columns-3 gap-6 text-[13.5px]">
        {d.notes.map(n => (
          <div key={n.id} className="break-inside-avoid mb-4 pl-3 border-l-[3px]" style={{ borderColor: n.studied ? recallColor(n.recall_on_exam) : 'var(--color-mist-deep)' }}>
            <p className="font-display font-bold">{n.title}</p>
            {n.level === 'line' ? <p className="leading-snug">{n.line}</p> : <Markdown text={n.compact} />}
          </div>
        ))}
        {d.formulas.length > 0 && (
          <div className="break-inside-avoid mb-4 pl-3 border-l-[3px] border-act">
            <p className="font-display font-bold">Formulas</p>
            <ul className="grid gap-1.5 mt-1">{d.formulas.map(f => <li key={f.id}><Formula src={f.latex} /> <span className="text-ink-soft">{f.name}</span></li>)}</ul>
          </div>
        )}
      </div>
    </Card>
  );
}

function MindMap({ d }: { d: Data }) {
  const chapters = [...new Set(d.notes.map(n => n.chapter ?? d.subject.name))];
  const W = 1120, H = 640, cx = W / 2, cy = H / 2;
  const nodes = chapters.map((ch, i) => {
    const a = (i / chapters.length) * Math.PI * 2 - Math.PI / 2;
    const topics = d.notes.filter(n => (n.chapter ?? d.subject.name) === ch);
    return { ch, a, x: cx + Math.cos(a) * 170, y: cy + Math.sin(a) * 140, topics };
  });
  const short = (s: string, n = 26) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
  return (
    <Card className="p-3 overflow-x-auto">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full min-w-[720px]" role="img" aria-label={`Mind map of ${d.subject.name}`}>
        {nodes.map(n => n.topics.map((t, k) => {
          const spread = Math.min(1.1, 0.42 * n.topics.length) / Math.max(1, n.topics.length - 1);
          const a = n.a + (k - (n.topics.length - 1) / 2) * (n.topics.length > 1 ? spread : 0);
          const x = cx + Math.cos(a) * 365, y = cy + Math.sin(a) * 255;
          const left = Math.cos(a) < -0.2;
          const color = t.studied ? recallColor(t.recall_on_exam) : 'var(--color-mist-deep)';
          return (
            <g key={t.id}>
              <path d={`M${n.x},${n.y} Q${(n.x + x) / 2 + Math.cos(a) * 20},${(n.y + y) / 2} ${x},${y}`} stroke="var(--color-mist-deep)" strokeWidth="1.5" fill="none" />
              <circle cx={x} cy={y} r="7" fill={color} />
              <text x={x + (left ? -13 : 13)} y={y + 4.5} textAnchor={left ? 'end' : 'start'} fontSize="14" fill="var(--color-ink)" fontFamily="var(--font-sans)">{short(t.title)}</text>
              <text x={x + (left ? -13 : 13)} y={y + 21} textAnchor={left ? 'end' : 'start'} fontSize="11.5" fill="var(--color-ink-soft)" fontFamily="var(--font-sans)">{t.studied ? `${pct(t.recall_on_exam)} on exam day` : 'not studied'}</text>
            </g>
          );
        }))}
        {nodes.map(n => (
          <g key={n.ch}>
            <line x1={cx} y1={cy} x2={n.x} y2={n.y} stroke="var(--color-mist-deep)" strokeWidth="2.5" />
            <rect x={n.x - 78} y={n.y - 19} width="156" height="38" rx="19" fill="var(--color-card)" stroke="var(--color-ink)" strokeWidth="1.5" />
            <text x={n.x} y={n.y + 5} textAnchor="middle" fontSize="14" fontWeight="700" fill="var(--color-ink)" fontFamily="var(--font-display)">{short(n.ch.replace(/^(chapter|unit)\s+\d+\s*/i, ''), 19)}</text>
          </g>
        ))}
        <circle cx={cx} cy={cy} r="52" fill="var(--color-solid)" />
        <text x={cx} y={cy + 6} textAnchor="middle" fontSize="18" fontWeight="800" fill="var(--color-on-solid)" fontFamily="var(--font-display)">{short(d.subject.name, 12)}</text>
      </svg>
      <div className="flex gap-5 justify-center text-xs text-ink-soft pb-2">
        {[['var(--color-clear)', 'Will remember'], ['var(--color-haze)', 'Fading'], ['var(--color-storm)', 'Likely to forget'], ['var(--color-mist-deep)', 'Not studied']].map(([c, l]) => (
          <span key={l} className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full" style={{ background: c }} />{l}</span>
        ))}
      </div>
    </Card>
  );
}

function Flashcards({ d }: { d: Data }) {
  const cards = useMemo(() => [
    ...d.notes.filter(n => n.line).map(n => ({ key: `t${n.id}`, front: n.title, back: n.line!, recall: n.studied ? n.recall_on_exam : 0, formula: false })),
    ...d.formulas.map(f => ({ key: `f${f.id}`, front: `${f.name}`, back: f.latex, recall: f.recall_on_exam, formula: true })),
  ].sort((a, b) => a.recall - b.recall), [d]);
  const [i, setI] = useState(0);
  const [flip, setFlip] = useState(false);
  const [known, setKnown] = useState(0);
  if (!cards.length) return <Empty title="No flashcards yet">Upload a PDF to make flashcards.</Empty>;
  const c = cards[i % cards.length];
  const go = (k: boolean) => { if (k) setKnown(n => n + 1); setFlip(false); setI(n => n + 1); };
  return (
    <div className="max-w-xl mx-auto">
      <p className="text-sm text-ink-soft mb-3 text-center">Weakest first. Card {(i % cards.length) + 1} of {cards.length}, {known} known this round</p>
      <button onClick={() => setFlip(f => !f)} className="w-full" aria-label="Flip card">
        <Card className={`min-h-64 p-8 grid place-items-center text-center transition-colors ${flip ? 'bg-act-soft border-act/30' : ''}`}>
          {!flip ? (
            <div>
              <p className="font-display text-3xl font-bold">{c.front}</p>
              <p className="text-sm text-ink-soft mt-4 flex items-center gap-1.5 justify-center"><RotateCw size={14} /> Tap to flip</p>
            </div>
          ) : c.formula ? <div className="text-2xl"><Formula src={c.back} block /></div> : <p className="text-lg leading-relaxed">{c.back}</p>}
        </Card>
      </button>
      <div className="grid grid-cols-2 gap-3 mt-4">
        <Button variant="soft" onClick={() => go(false)}>Didn't know</Button>
        <Button onClick={() => go(true)}>Knew it</Button>
      </div>
    </div>
  );
}

function Chapters({ d }: { d: Data }) {
  const chapters = [...new Set(d.notes.map(n => n.chapter ?? 'Notes'))];
  return (
    <div className="grid gap-6 max-w-3xl">
      {chapters.map(ch => (
        <Card key={ch} className="p-6 md:p-8">
          <h2 className="text-2xl font-extrabold mb-4">{ch}</h2>
          {d.notes.filter(n => (n.chapter ?? 'Notes') === ch).map(n => (
            <div key={n.id} className="mb-5 last:mb-0">
              <h3 className="font-bold text-lg mb-1">{n.title}</h3>
              <p className="leading-[1.75] text-[15.5px]">{n.simple || n.line}</p>
            </div>
          ))}
        </Card>
      ))}
    </div>
  );
}

function FormulaSheet({ d }: { d: Data }) {
  if (!d.formulas.length) return <Empty title="No formulas found">This subject's PDFs have no formulas yet.</Empty>;
  return (
    <Card className="divide-y divide-mist">
      <p className="px-5 py-3 text-sm text-ink-soft">Sorted by how likely you are to forget each one by the exam, most at risk first.</p>
      {d.formulas.map((f, k) => (
        <div key={f.id} className="grid sm:grid-cols-[28px_1fr_auto] gap-x-4 gap-y-1 items-center px-5 py-4">
          <span className="font-display font-bold text-ink-soft">{k + 1}</span>
          <div>
            <div className="text-lg"><Formula src={f.latex} /></div>
            <p className="text-sm text-ink-soft mt-0.5">{f.name}{f.meaning ? `: ${f.meaning}` : ''}. From {f.topic}.</p>
          </div>
          {f.studied ? <RecallBar value={f.recall_on_exam} width="w-32" label="Predicted recall on exam day" /> : <span className="text-sm text-ink-soft">not studied</span>}
        </div>
      ))}
    </Card>
  );
}

function LastNight({ d }: { d: Data }) {
  const { topics, formulas, at } = d.lastNight;
  return (
    <Card className="p-6 md:p-8 max-w-3xl">
      <div className="flex items-center gap-2 mb-1"><Moon size={20} className="text-act" /><h2 className="text-2xl font-extrabold">Last night sheet</h2></div>
      <p className="text-ink-soft mb-6">Only what you are predicted to have below 70% recall by {new Date(at).toLocaleString(undefined, { weekday: 'long', hour: 'numeric', minute: '2-digit' })}. Read this once tonight.</p>
      {!topics.length && !formulas.length ? <p>Nothing at risk. Sleep well.</p> : (
        <div className="grid gap-5">
          {topics.map(n => (
            <div key={n.id}>
              <div className="flex justify-between gap-3 items-baseline">
                <h3 className="font-bold text-lg">{n.title}</h3>
                <span className="text-sm tabular-nums" style={{ color: recallColor(n.recall_tomorrow) }}>{pct(n.recall_tomorrow)} by then</span>
              </div>
              <Markdown text={n.compact} />
            </div>
          ))}
          {formulas.length > 0 && (
            <div>
              <h3 className="font-bold text-lg mb-2">Formulas to look at again</h3>
              <ul className="grid gap-2">{formulas.map(f => <li key={f.id} className="flex flex-wrap gap-x-3"><Formula src={f.latex} /><span className="text-ink-soft text-sm">{f.name}</span></li>)}</ul>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

export default function Notes() {
  const { id } = useParams();
  const nav = useNavigate();
  const [subjects, setSubjects] = useState<Subject[] | null>(null);
  const [d, setD] = useState<Data | null>(null);
  const [tab, setTab] = useState<Tab>(() => (new URLSearchParams(location.search).get('tab') as Tab) || 'smart');

  useEffect(() => { api<{ subjects: Subject[] }>('/subjects').then(r => setSubjects(r.subjects)); }, []);
  const sid = id ? Number(id) : subjects?.[0]?.id;
  useEffect(() => { if (sid) { setD(null); api<Data>(`/notes/${sid}`).then(setD); } }, [sid]);

  if (subjects && !subjects.length) return <div><PageTitle title="Notes" /><Empty title="No subjects yet">Add a subject and upload a PDF to get notes.</Empty></div>;

  return (
    <div>
      <PageTitle title="Notes" sub="Made from your PDFs and shaped by your memory: what you forget gets more detail."
        right={<Button variant="ghost" className="no-print" onClick={() => print()}><Printer size={16} /> Print</Button>} />
      <div className="flex flex-wrap gap-2 mb-4 no-print">
        {subjects?.map(s => (
          <button key={s.id} onClick={() => nav(`/notes/${s.id}`)}
            className={`flex items-center gap-2 rounded-full px-3.5 py-1.5 text-sm font-bold border ${s.id === sid ? 'bg-solid text-on-solid border-solid' : 'bg-card border-mist-deep text-ink-soft'}`}>
            <span className="w-2 h-2 rounded-full" style={{ background: s.color }} />{s.name}
          </button>
        ))}
      </div>
      <div className="flex gap-1 overflow-x-auto border-b border-mist mb-6 no-print" role="tablist">
        {TABS.map(t => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}
            className={`whitespace-nowrap px-3.5 py-2.5 text-sm font-bold border-b-2 -mb-px ${tab === t.id ? 'border-act text-act' : 'border-transparent text-ink-soft hover:text-ink'}`}>
            {t.label}
          </button>
        ))}
      </div>
      {!d ? <p className="text-ink-soft">Loading notes…</p> : !d.notes.length ? <Empty title="No notes yet">Upload a PDF for {d.subject.name} and notes appear here.</Empty> : (
        <>
          {tab === 'smart' && <SmartNotes d={d} />}
          {tab === 'cheat' && <CheatSheet d={d} />}
          {tab === 'map' && <MindMap d={d} />}
          {tab === 'cards' && <Flashcards d={d} />}
          {tab === 'chapters' && <Chapters d={d} />}
          {tab === 'formulas' && <FormulaSheet d={d} />}
          {tab === 'night' && <LastNight d={d} />}
          <p className="text-xs text-ink-soft mt-6">Exam on {fmtDate(d.subject.exam_at)}.</p>
        </>
      )}
    </div>
  );
}
