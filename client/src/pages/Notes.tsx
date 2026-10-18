import { Fragment, useEffect, useMemo, useState } from 'react';
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

/** Chapter names straight from a PDF can be blank or just "."; give those a plain name. */
function chapterGroups(d: Data) {
  const groups: { raw: string; name: string; topics: Note[] }[] = [];
  for (const n of d.notes) {
    const raw = (n.chapter ?? '').replace(/\s+/g, ' ').trim();
    const name = /[A-Za-z]{2}|\d/.test(raw) ? raw : '';
    const last = groups[groups.length - 1];
    if (last && last.raw === raw) last.topics.push(n);
    else groups.push({ raw, name, topics: [n] });
  }
  let k = 0;
  return groups.map(g => ({ ...g, name: g.name || (groups.length === 1 ? d.subject.name : `Part ${++k}`) }));
}

type Band = 'clear' | 'haze' | 'storm' | 'new';
const bandOf = (n: Note): Band => (!n.studied ? 'new' : n.recall_on_exam >= 0.8 ? 'clear' : n.recall_on_exam >= 0.6 ? 'haze' : 'storm');
const BAND_COLOR: Record<Band, string> = { clear: 'var(--color-clear)', haze: 'var(--color-haze)', storm: 'var(--color-storm)', new: 'var(--color-mist-deep)' };
const BAND_LABEL: Record<Band, string> = { clear: 'Will remember', haze: 'Fading', storm: 'Likely to forget', new: 'Not studied' };

/** Topic map: subject → chapters → topics, as a compact tree. Tap a topic to see its key line and quiz it. */
function MindMap({ d }: { d: Data }) {
  const groups = chapterGroups(d);
  const [show, setShow] = useState<'all' | 'risk' | 'new'>('all');
  const [sel, setSel] = useState<number | null>(null);
  const keep = (n: Note) => show === 'all' || (show === 'new' ? !n.studied : bandOf(n) === 'storm' || bandOf(n) === 'haze' || n.danger);
  const nRisk = d.notes.filter(n => n.studied && (bandOf(n) !== 'clear' || n.danger)).length;
  const nNew = d.notes.filter(n => !n.studied).length;

  return (
    <Card className="p-4 md:p-6 min-w-0">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-xl font-bold break-words">{d.subject.name}</h2>
          <p className="text-sm text-ink-soft">{d.notes.length} topics in {groups.length} {groups.length === 1 ? 'chapter' : 'chapters'}. Tap a topic to see its key point.</p>
        </div>
        <div className="flex gap-1 rounded-full bg-paper p-1 text-xs font-bold" role="group" aria-label="Which topics to show">
          {([['all', `All ${d.notes.length}`], ['risk', `At risk ${nRisk}`], ['new', `Not studied ${nNew}`]] as const).map(([k, l]) => (
            <button key={k} onClick={() => setShow(k)} aria-pressed={show === k}
              className={`rounded-full px-3 py-1.5 ${show === k ? 'bg-card text-ink shadow-sm' : 'text-ink-soft hover:text-ink'}`}>{l}</button>
          ))}
        </div>
      </div>

      <ol className="mt-5 relative border-l-2 border-mist-deep ml-1.5">
        {groups.map((g, gi) => {
          const topics = g.topics.filter(keep);
          const mix = (['clear', 'haze', 'storm', 'new'] as Band[]).map(b => [b, g.topics.filter(t => bandOf(t) === b).length] as const);
          return (
            <li key={gi} className="relative pl-5 pb-5 last:pb-0">
              <span className="absolute -left-[7px] top-1.5 w-3 h-3 rounded-full bg-card border-2 border-ink" />
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <h3 className="font-display font-bold text-[15px] leading-snug min-w-0 break-words">{g.name}</h3>
                <span className="text-xs text-ink-soft tabular-nums">{g.topics.length} {g.topics.length === 1 ? 'topic' : 'topics'}</span>
                <span className="flex h-1.5 w-20 rounded-full overflow-hidden bg-mist" title={mix.filter(([, c]) => c).map(([b, c]) => `${c} ${BAND_LABEL[b].toLowerCase()}`).join(', ')}>
                  {mix.map(([b, c]) => c ? <span key={b} style={{ width: `${(c / g.topics.length) * 100}%`, background: BAND_COLOR[b] }} /> : null)}
                </span>
              </div>
              {topics.length ? (
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {topics.map(t => (<Fragment key={t.id}>
                    <button onClick={() => setSel(s => (s === t.id ? null : t.id))} aria-expanded={sel === t.id} title={t.title}
                      className={`max-w-full inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12.5px] leading-tight text-left transition-colors
                        ${sel === t.id ? 'border-act bg-act-soft' : 'border-mist bg-paper hover:border-mist-deep'}`}>
                      <span className="w-2 h-2 rounded-full shrink-0" style={{ background: BAND_COLOR[bandOf(t)] }} />
                      <span className="truncate">{t.title}</span>
                      {t.studied && <span className="text-ink-soft tabular-nums shrink-0">{pct(t.recall_on_exam)}</span>}
                      {t.danger && <AlertTriangle size={11} className="text-storm shrink-0" aria-label="Risky" />}
                    </button>
                    {sel === t.id && <TopicPeek t={t} />}
                  </Fragment>))}
                </div>
              ) : <p className="text-xs text-ink-soft mt-1.5">Nothing here for this filter.</p>}
            </li>
          );
        })}
      </ol>

      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-soft mt-5 pt-4 border-t border-mist">
        {(Object.keys(BAND_LABEL) as Band[]).map(b => (
          <span key={b} className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full" style={{ background: BAND_COLOR[b] }} />{BAND_LABEL[b]}</span>
        ))}
        <span className="sm:ml-auto">% = predicted recall on exam day</span>
      </div>
    </Card>
  );
}

/** Opens right under the tapped topic (full row width), so it stays next to what you tapped. */
function TopicPeek({ t: selected }: { t: Note }) {
  return (
                <div className="basis-full my-1 rounded-xl border border-mist bg-paper p-3.5 text-sm min-w-0">
                  <p className="font-bold break-words">{selected.title}</p>
                  <p className="text-xs text-ink-soft mt-0.5">
                    {selected.studied ? `${pct(selected.recall_on_exam)} predicted on exam day, ${BAND_LABEL[bandOf(selected)].toLowerCase()}` : 'Not studied yet'}
                    {selected.page_from ? `. Pages ${selected.page_from}–${selected.page_to}` : ''}
                  </p>
                  {selected.line && <div className="mt-2 leading-relaxed prose-note"><Markdown text={selected.line} /></div>}
                  <Link to={`/quiz?topicId=${selected.id}`}><Button variant="soft" className="mt-3 py-1.5 text-sm">Quiz this topic</Button></Link>
                </div>
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
  return (
    <div className="grid gap-6 max-w-3xl">
      {chapterGroups(d).map((g, gi) => (
        <Card key={gi} className="p-6 md:p-8">
          <h2 className="text-2xl font-extrabold mb-4 break-words">{g.name}</h2>
          {g.topics.map(n => (
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
  // One card per topic, topics you are most likely to forget first; formulas inside in book order.
  const groups = new Map<number, { topic: string; topicId: number; items: FormulaRow[]; risk: number; studied: boolean }>();
  for (const f of d.formulas) {
    const g = groups.get(f.topicId) ?? { topic: f.topic, topicId: f.topicId, items: [], risk: 1, studied: false };
    g.items.push(f);
    if (f.studied) { g.studied = true; g.risk = Math.min(g.risk, f.recall_on_exam); }
    groups.set(f.topicId, g);
  }
  const list = [...groups.values()].sort((a, b) => (a.studied === b.studied ? a.risk - b.risk : a.studied ? -1 : 1));
  const order = new Map(d.notes.map((n, i) => [n.id, i]));
  return (
    <div className="grid gap-4">
      <p className="text-sm text-ink-soft">Grouped by topic. Topics you are most likely to forget by the exam come first.</p>
      {list.map(g => (
        <Card key={g.topicId} className="p-4 md:p-5 min-w-0">
          <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
            <h3 className="text-lg font-bold min-w-0 break-words">{g.topic}</h3>
            {g.studied ? <RecallBar value={g.risk} width="w-36" label="Predicted recall on exam day" /> : <span className="text-xs text-ink-soft">not studied yet</span>}
          </div>
          <div className="grid gap-3">
            {g.items.sort((a, b) => a.id - b.id || (order.get(a.topicId) ?? 0) - (order.get(b.topicId) ?? 0)).map(f => (
              <div key={f.id} className="rounded-xl bg-paper px-4 py-3 min-w-0">
                <p className="text-sm font-bold">{f.name}</p>
                <div className="my-1"><Formula src={f.latex} block /></div>
                {f.meaning && <div className="text-sm text-ink-soft"><Markdown text={f.meaning} /></div>}
              </div>
            ))}
          </div>
        </Card>
      ))}
    </div>
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
