import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus, X, FileUp, Loader2 } from 'lucide-react';
import { api, type Subject } from '../api.ts';
import { Button, Card, Empty, PageTitle, daysUntil, fmtDate } from '../ui.tsx';

interface Row { name: string; examAt: string; totalMarks: string; topics: string; files: File[] }
const blank = (): Row => ({ name: '', examAt: '', totalMarks: '100', topics: '', files: [] });

function AddSubjects({ onDone, onClose }: { onDone: () => void; onClose: () => void }) {
  const [rows, setRows] = useState<Row[]>([blank()]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (i: number, patch: Partial<Row>) => setRows(rs => rs.map((r, k) => (k === i ? { ...r, ...patch } : r)));

  async function save() {
    setError(''); setBusy(true);
    try {
      const filled = rows.filter(r => r.name.trim());
      const r = await api<{ created: number[]; errors: string[] }>('/subjects', {
        body: { subjects: filled.map(x => ({ name: x.name, examAt: x.examAt, totalMarks: Number(x.totalMarks), topics: x.topics })) },
      });
      // Upload each subject's PDFs; processing continues in the background.
      await Promise.all(r.created.map((id, k) => {
        const files = filled[k]?.files ?? [];
        if (!files.length) return null;
        const form = new FormData();
        files.forEach(f => form.append('files', f));
        return api(`/subjects/${id}/sources`, { form });
      }));
      if (r.errors.length) setError(r.errors.join('. '));
      else onDone();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  return (
    <Card className="p-5 md:p-6 mb-8 border-act/30">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-bold">Add subjects</h2>
        <button onClick={onClose} aria-label="Close" className="text-ink-soft hover:text-ink"><X size={20} /></button>
      </div>
      <div className="grid gap-4">
        {rows.map((r, i) => (
          <div key={i} className="grid gap-3 md:grid-cols-[1.4fr_1fr_90px_1.4fr_auto] items-start rounded-xl bg-paper p-3">
            <input value={r.name} onChange={e => set(i, { name: e.target.value })} placeholder="Subject, e.g. Physics" aria-label="Subject name"
              className="rounded-lg border border-mist-deep bg-card px-3 py-2.5 outline-none focus:border-act" />
            <input type="date" value={r.examAt} onChange={e => set(i, { examAt: e.target.value })} aria-label="Exam date"
              className="rounded-lg border border-mist-deep bg-card px-3 py-2.5 outline-none focus:border-act" />
            <input value={r.totalMarks} onChange={e => set(i, { totalMarks: e.target.value })} inputMode="numeric" aria-label="Total marks" title="Total marks"
              className="rounded-lg border border-mist-deep bg-card px-3 py-2.5 outline-none focus:border-act" />
            <div className="grid gap-2">
              <label className="flex items-center gap-2 rounded-lg border border-dashed border-mist-deep bg-card px-3 py-2.5 text-sm text-ink-soft cursor-pointer hover:border-act">
                <FileUp size={16} />
                <span className="truncate">{r.files.length ? r.files.map(f => f.name).join(', ') : 'Add PDFs or a book (optional)'}</span>
                <input type="file" accept="application/pdf" multiple className="sr-only" onChange={e => set(i, { files: [...(e.target.files ?? [])] })} />
              </label>
              <textarea value={r.topics} onChange={e => set(i, { topics: e.target.value })} rows={2} placeholder="Or type topics, one per line"
                className="rounded-lg border border-mist-deep bg-card px-3 py-2 text-sm outline-none focus:border-act" />
            </div>
            <button onClick={() => setRows(rs => rs.length > 1 ? rs.filter((_, k) => k !== i) : rs)} aria-label="Remove row"
              className="text-ink-soft hover:text-storm p-2"><X size={18} /></button>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-3 mt-4">
        <Button variant="soft" onClick={() => setRows(rs => [...rs, blank()])}><Plus size={16} /> Another subject</Button>
        <Button onClick={save} disabled={busy || !rows.some(r => r.name.trim() && r.examAt)}>
          {busy ? <><Loader2 size={16} className="animate-spin" /> Saving</> : `Save ${rows.filter(r => r.name.trim()).length || ''} subject${rows.filter(r => r.name.trim()).length === 1 ? '' : 's'}`}
        </Button>
        {error && <p className="text-storm text-sm" role="alert">{error}</p>}
      </div>
    </Card>
  );
}

export default function Subjects() {
  const [subjects, setSubjects] = useState<Subject[] | null>(null);
  const [adding, setAdding] = useState(false);
  const load = () => api<{ subjects: Subject[] }>('/subjects').then(r => { setSubjects(r.subjects); if (!r.subjects.length) setAdding(true); });
  useEffect(() => { load(); }, []);

  return (
    <div>
      <PageTitle title="Subjects" sub="Each subject has an exam date, topics and the PDFs you study from."
        right={!adding && <Button onClick={() => setAdding(true)}><Plus size={16} /> Add subjects</Button>} />
      {adding && <AddSubjects onClose={() => setAdding(false)} onDone={() => { setAdding(false); load(); }} />}
      {subjects && !subjects.length && !adding && <Empty title="No subjects yet">Add your first subject to get started.</Empty>}
      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {subjects?.map(s => (
          <Link key={s.id} to={`/subjects/${s.id}`}>
            <Card className="p-5 h-full hover:border-act/40 transition-colors">
              <div className="flex items-center gap-2">
                <span className="w-2.5 h-2.5 rounded-full" style={{ background: s.color }} />
                <h2 className="text-lg font-bold">{s.name}</h2>
              </div>
              <p className="text-sm text-ink-soft mt-1">Exam {fmtDate(s.exam_at)}, {daysUntil(s.exam_at)} days left</p>
              <div className="mt-5 flex gap-6 text-sm">
                <div><p className="font-display text-2xl font-bold">{s.topic_count}</p><p className="text-ink-soft">topics</p></div>
                <div><p className="font-display text-2xl font-bold">{s.studied_count}</p><p className="text-ink-soft">studied</p></div>
                <div><p className="font-display text-2xl font-bold">{s.source_count}</p><p className="text-ink-soft">PDFs</p></div>
              </div>
              {s.processing && <p className="mt-4 text-sm text-act flex items-center gap-2"><Loader2 size={14} className="animate-spin" /> Reading PDFs…</p>}
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
