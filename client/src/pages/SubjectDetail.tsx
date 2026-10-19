import { Fragment, useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { AlertTriangle, FileUp, Loader2, Scissors, Trash2, Zap, NotebookPen, Plus, CheckCircle2, XCircle, ScanText, FileQuestion, X } from 'lucide-react';
import { api, type Subject } from '../api.ts';
import { Button, Card, Empty, RecallBar, conditions, daysUntil, fmtDate } from '../ui.tsx';

interface Topic {
  id: number; title: string; chapter: string | null; weight: number; weight_source: string; difficulty: number; est_learn_min: number;
  skip: boolean; studied: boolean; recall_now: number; half_life: number | null; fade_days: number | null; mastery: number;
  question_count: number; recall_on_exam: number | null; danger: boolean; calibration: { expectedPct: number; accuracyPct: number; n: number } | null;
  paper_count: number; paper_marks: number;
}
interface Source { id: number; title: string; kind: string; pages: number | null; status: string; progress: number; error: string | null; note: string | null; ocr_pages: number; year: number | null; retry_after?: number | null }
interface Paper { id: number; title: string; year: number | null; status: string; error: string | null; questions: number; matched: number }
interface Unmatched { id: number; number: string; text: string; marks: number; year: number | null }
interface Triage { active: boolean; requiredMinutes: number; availableMinutes: number; skippedMarks: number; items: { topicId: number; title: string; kind: string; hours: number; marksGain: number; marksPerHour: number; decision: string }[] }
interface Data { subject: Subject; topics: Topic[]; sources: Source[]; papers: Paper[]; unmatchedQuestions: Unmatched[]; triage: Triage | null; forecast: { readiness: number; scoreP10: number; scoreP90: number; totalMarks: number } | null }

export default function SubjectDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const [d, setD] = useState<Data | null>(null);
  const [newTopics, setNewTopics] = useState('');
  const [uploading, setUploading] = useState(false);
  const [showTriage, setShowTriage] = useState(false);
  const load = useCallback(() => api<Data>(`/subjects/${id}`).then(setD), [id]);
  useEffect(() => { load(); }, [load]);

  // Poll while PDFs are being read.
  useEffect(() => {
    if (!d?.sources.some(s => s.status === 'queued' || s.status === 'processing')) return;
    const t = setInterval(load, 1500);
    return () => clearInterval(t);
  }, [d, load]);

  if (!d) return <p className="text-ink-soft">Loading…</p>;
  const s = d.subject;
  const totalW = d.topics.reduce((a, t) => a + t.weight, 0) || 1;
  const marks = (t: Topic) => (t.weight / totalW) * s.total_marks;
  const c = d.forecast ? conditions(d.forecast.readiness) : null;
  const chapters = [...new Set(d.topics.map(t => t.chapter ?? ''))];

  async function upload(files: FileList | null, kind: 'pdf' | 'past_paper' = 'pdf') {
    if (!files?.length) return;
    setUploading(true);
    const form = new FormData();
    form.append('kind', kind); // must come before the files so the server sees it
    [...files].forEach(f => form.append('files', f));
    try { await api(`/subjects/${id}/sources`, { form }); await load(); } finally { setUploading(false); }
  }
  async function addTopics() {
    await api(`/subjects/${id}/topics`, { body: { titles: newTopics.split('\n') } });
    setNewTopics(''); load();
  }
  async function toggleSkip(t: Topic) { await api(`/topics/${t.id}`, { method: 'PATCH', body: { skip: !t.skip } }); load(); }

  return (
    <div>
      <header className="flex flex-wrap items-end justify-between gap-4 mb-6">
        <div>
          <Link to="/subjects" className="text-sm text-ink-soft hover:text-ink">Subjects</Link>
          <div className="flex items-center gap-2.5 mt-1">
            <span className="w-3 h-3 rounded-full" style={{ background: s.color }} />
            <h1 className="text-3xl md:text-4xl font-extrabold">{s.name}</h1>
          </div>
          <p className="text-ink-soft mt-1">Exam on {fmtDate(s.exam_at)}, {daysUntil(s.exam_at)} days left. {s.total_marks} marks.</p>
        </div>
        <div className="flex gap-2">
          <Link to={`/quiz?subjectId=${s.id}`}><Button><Zap size={16} /> Quiz</Button></Link>
          <Link to={`/notes/${s.id}`}><Button variant="soft"><NotebookPen size={16} /> Notes</Button></Link>
        </div>
      </header>

      {d.forecast && c && (
        <div className="flex flex-wrap items-baseline gap-x-8 gap-y-2 mb-6">
          <p><span className="font-display text-4xl font-extrabold" style={{ color: c.tone }}>{Math.round(d.forecast.readiness)}%</span> <span className="font-bold" style={{ color: c.tone }}>{c.word}</span></p>
          <p className="text-ink-soft">Likely score <b className="text-ink">{d.forecast.scoreP10}–{d.forecast.scoreP90}</b> of {d.forecast.totalMarks}</p>
        </div>
      )}

      {d.triage?.active && (
        <Card className="p-5 mb-6 border-haze/50 bg-haze-soft">
          <div className="flex flex-wrap items-start gap-3">
            <Scissors className="text-haze shrink-0 mt-0.5" size={20} />
            <div className="flex-1 min-w-[240px]">
              <p className="font-bold">Triage mode is on</p>
              <p className="text-ink-soft text-sm mt-0.5">You need about {(d.triage.requiredMinutes / 60).toFixed(1)} hours of study but have {(d.triage.availableMinutes / 60).toFixed(1)} before the exam. {d.triage.skippedMarks >= 0.5
                ? `Do the topics with the most marks per hour; skipping the rest costs about ${Math.round(d.triage.skippedMarks)} mark${Math.round(d.triage.skippedMarks) === 1 ? '' : 's'}.`
                : 'It is tight: everything fits only if you follow the plan in order, highest marks per hour first.'}</p>
            </div>
            <Button variant="soft" onClick={() => setShowTriage(v => !v)}>{showTriage ? 'Hide list' : 'Show do and skip list'}</Button>
          </div>
          {showTriage && (
            <table className="w-full mt-4 text-sm">
              <thead className="text-left text-ink-soft"><tr><th className="py-1.5 font-normal">Topic</th><th className="font-normal text-right">Hours</th><th className="font-normal text-right">Marks gained</th><th className="font-normal text-right">Marks per hour</th><th className="font-normal text-right">Decision</th></tr></thead>
              <tbody>
                {d.triage.items.filter(i => i.marksGain > 0.2).map(i => (
                  <tr key={i.topicId} className="border-t border-mist">
                    <td className="py-2">{i.title}</td>
                    <td className="text-right tabular-nums">{i.hours.toFixed(1)}</td>
                    <td className="text-right tabular-nums">+{i.marksGain.toFixed(1)}</td>
                    <td className="text-right tabular-nums font-bold">{i.marksPerHour.toFixed(1)}</td>
                    <td className="text-right">{i.decision === 'do'
                      ? <span className="inline-flex items-center gap-1 text-clear font-bold"><CheckCircle2 size={14} /> Do</span>
                      : <span className="inline-flex items-center gap-1 text-storm font-bold"><XCircle size={14} /> Skip</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      )}

      <div className="grid lg:grid-cols-[minmax(0,1fr)_300px] gap-6">
        <Card className="min-w-0 overflow-hidden">
          {!d.topics.length ? (
            <div className="p-6"><Empty title="No topics yet">Upload a PDF or type your topics on the right.</Empty></div>
          ) : (
            <div className="text-sm">
              {/* Column headings: only on wider screens. On phones each topic is a small card. */}
              <div className="hidden md:grid grid-cols-[minmax(0,1fr)_118px_118px_52px_96px] gap-3 px-5 py-3 text-ink-soft border-b border-mist">
                <span>Topic</span><span>Recall now</span><span>On exam day</span><span className="text-right">Marks</span><span className="sr-only">Actions</span>
              </div>
              {chapters.map(ch => (
                <Fragment key={ch || 'none'}>
                  {ch && <p className="px-4 md:px-5 pt-4 pb-1.5 font-display font-bold text-ink-soft break-words">{ch}</p>}
                  {d.topics.filter(t => (t.chapter ?? '') === ch).map(t => (
                    <div key={t.id} className={`border-t border-mist px-4 md:px-5 py-3 grid gap-x-3 gap-y-2 grid-cols-2 md:grid-cols-[minmax(0,1fr)_118px_118px_52px_96px] md:items-center ${t.skip ? 'opacity-45' : ''}`}>
                      <div className="col-span-2 md:col-span-1 min-w-0">
                        <p className="font-bold break-words">
                          {t.title}
                          {t.danger && <span title="You feel sure but score low" className="ml-1.5 inline-flex items-center gap-1 rounded-full bg-storm-soft text-storm text-[11px] px-2 py-0.5 align-middle"><AlertTriangle size={11} /> Risky</span>}
                        </p>
                        <p className="text-xs text-ink-soft mt-0.5">
                          {!t.studied ? `Not studied yet, about ${t.est_learn_min} min to learn`
                            : t.fade_days != null && t.fade_days < 0.5 ? 'Half forgotten already, review soon'
                            : `Fades to 50% in ${Math.round(t.fade_days ?? 0)} day${Math.round(t.fade_days ?? 0) === 1 ? '' : 's'}`}
                          {t.danger && t.calibration && `. You feel ${(t.calibration.expectedPct / 20).toFixed(1)}/5 sure but score ${Math.round(t.calibration.accuracyPct)}%`}
                        </p>
                      </div>
                      <div className="min-w-0">
                        <p className="md:hidden text-[11px] text-ink-soft mb-1">Recall now</p>
                        {t.studied ? <RecallBar value={t.recall_now} width="w-full" /> : <span className="text-ink-soft">–</span>}
                      </div>
                      <div className="min-w-0">
                        <p className="md:hidden text-[11px] text-ink-soft mb-1">On exam day</p>
                        {t.recall_on_exam != null && (t.studied || t.recall_on_exam > 0) ? <RecallBar value={t.recall_on_exam * (t.mastery || 0.78)} width="w-full" label="Expected share of this topic's marks" /> : <span className="text-ink-soft">–</span>}
                      </div>
                      <div className="md:text-right">
                        <span className="md:hidden text-ink-soft">Marks </span><span className="tabular-nums font-bold md:font-normal">{marks(t).toFixed(0)}</span>
                        {t.weight_source === 'past_papers' && <span className="md:block text-[11px] text-ink-soft whitespace-nowrap">{t.paper_count ? ` asked ${t.paper_count}×` : ' not asked'}</span>}
                      </div>
                      <div className="text-right whitespace-nowrap">
                        {t.question_count > 0 && <button onClick={() => nav(`/quiz?topicId=${t.id}`)} className="text-act font-bold text-xs mr-3 py-1">Quiz</button>}
                        <button onClick={() => toggleSkip(t)} className="text-ink-soft text-xs hover:text-ink py-1">{t.skip ? 'Unskip' : 'Skip'}</button>
                      </div>
                    </div>
                  ))}
                </Fragment>
              ))}
            </div>
          )}
        </Card>

        <div className="grid gap-4 content-start min-w-0">
          <Card className="p-5">
            <h2 className="font-bold mb-3">Books and notes</h2>
            <label className="flex flex-col items-center gap-2 rounded-xl border-2 border-dashed border-mist-deep p-5 text-center text-sm text-ink-soft cursor-pointer hover:border-act"
              onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); upload(e.dataTransfer.files); }}>
              {uploading ? <Loader2 className="animate-spin" /> : <FileUp />}
              <span>Drop PDFs here or <b className="text-act">choose files</b>. Scanned pages are read too. Topics, quizzes and notes are made for you.</span>
              <input type="file" accept="application/pdf" multiple className="sr-only" onChange={e => upload(e.target.files)} />
            </label>
            <SourceList sources={d.sources.filter(x => x.kind !== 'past_paper')} onDelete={async sid => { await api(`/sources/${sid}`, { method: 'DELETE' }); load(); }} />
          </Card>

          <Card className="p-5">
            <h2 className="font-bold">Past papers</h2>
            <p className="text-sm text-ink-soft mt-1 mb-3">Each question is matched to a topic. Topics asked often, with more marks and in recent years, get more weight.</p>
            <label className="flex items-center gap-2 rounded-xl border-2 border-dashed border-mist-deep px-4 py-3 text-sm text-ink-soft cursor-pointer hover:border-act"
              onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); upload(e.dataTransfer.files, 'past_paper'); }}>
              <FileQuestion size={18} /> <span>Add past papers (PDF, scans are fine)</span>
              <input type="file" accept="application/pdf" multiple className="sr-only" onChange={e => upload(e.target.files, 'past_paper')} />
            </label>
            <SourceList sources={d.sources.filter(x => x.kind === 'past_paper')} papers={d.papers} onDelete={async sid => { await api(`/sources/${sid}`, { method: 'DELETE' }); load(); }} />
            {d.unmatchedQuestions.length > 0 && (
              <div className="mt-4">
                <p className="text-sm font-bold mb-2">Questions without a topic</p>
                <ul className="grid gap-2">
                  {d.unmatchedQuestions.map(q => (
                    <li key={q.id} className="rounded-lg bg-paper p-2.5 text-sm">
                      <p className="line-clamp-2"><b>Q{q.number}</b>{q.year ? ` (${q.year})` : ''}, {q.marks} marks: {q.text}</p>
                      <select aria-label="Choose topic" defaultValue="" className="mt-1.5 w-full rounded-md border border-mist-deep bg-card px-2 py-1 text-sm"
                        onChange={async e => { await api(`/paper-questions/${q.id}`, { method: 'PATCH', body: { topicId: Number(e.target.value) } }); load(); }}>
                        <option value="" disabled>Belongs to topic…</option>
                        {d.topics.map(t => <option key={t.id} value={t.id}>{t.title}</option>)}
                      </select>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </Card>

          <Card className="p-5">
            <h2 className="font-bold mb-3">Add topics by hand</h2>
            <textarea value={newTopics} onChange={e => setNewTopics(e.target.value)} rows={3} placeholder="One topic per line"
              className="w-full rounded-lg border border-mist-deep bg-card px-3 py-2 text-sm outline-none focus:border-act" />
            <Button variant="soft" className="mt-2 w-full" onClick={addTopics} disabled={!newTopics.trim()}><Plus size={16} /> Add topics</Button>
          </Card>
          <Button variant="danger" onClick={async () => { if (confirm(`Delete ${s.name} and all its topics?`)) { await api(`/subjects/${s.id}`, { method: 'DELETE' }); nav('/subjects'); } }}>
            <Trash2 size={15} /> Delete subject
          </Button>
        </div>
      </div>
    </div>
  );
}

function SourceList({ sources, papers, onDelete }: { sources: Source[]; papers?: Paper[]; onDelete: (id: number) => void }) {
  if (!sources.length) return null;
  return (
    <div className="mt-3 grid gap-2.5">
      {sources.map(src => {
        const paper = papers?.find(p => p.id === src.id);
        const waiting = src.status === 'queued' && src.retry_after != null && src.retry_after > Date.now();
        return (
          <div key={src.id} className="text-sm group">
            <div className="flex justify-between gap-2 min-w-0">
              <span className="truncate font-bold min-w-0" title={src.title}>{src.title}</span>
              <span className="flex items-center gap-2 shrink-0">
                <span className={src.status === 'failed' ? 'text-storm' : 'text-ink-soft'}>
                  {src.status === 'done' ? (paper ? `${paper.year ?? 'year?'}, ${paper.matched}/${paper.questions} matched` : `${src.pages} page${src.pages === 1 ? '' : 's'}`) : src.status === 'failed' ? 'Failed' : waiting ? 'Waiting' : `${Math.round(src.progress * 100)}%`}
                </span>
                <button onClick={() => { if (confirm(`Remove ${src.title}?`)) onDelete(src.id); }} aria-label={`Remove ${src.title}`} className="text-ink-soft hover:text-storm"><X size={14} /></button>
              </span>
            </div>
            {src.ocr_pages > 0 && src.status === 'done' && <p className="text-xs text-ink-soft mt-0.5 flex items-center gap-1"><ScanText size={12} /> Read {src.ocr_pages} scanned or handwritten page{src.ocr_pages === 1 ? '' : 's'}</p>}
            {waiting && <p className="text-haze text-xs mt-0.5">The free daily AI limit is used up. This file carries on by itself at {new Date(src.retry_after!).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })}.</p>}
            {(src.status === 'processing' || src.status === 'queued') && !waiting && <div className="h-1 bg-mist rounded-full mt-1"><div className="h-full bg-act rounded-full transition-all" style={{ width: `${src.progress * 100}%` }} /></div>}
            {src.note && src.status === 'done' && <p className="text-haze text-xs mt-0.5">{src.note}</p>}
            {src.error && <p className="text-storm text-xs mt-0.5">{src.error}</p>}
          </div>
        );
      })}
    </div>
  );
}
