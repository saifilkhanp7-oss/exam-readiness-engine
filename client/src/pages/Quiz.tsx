import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Check, X, Shuffle, AlertTriangle, Clock } from 'lucide-react';
import { api } from '../api.ts';
import { getPack, offlineQuiz, queueQuiz, flushOutbox, refreshPack, type PackQuestion, type OfflineAnswer } from '../offline.ts';
import { Button, Card, Empty, Formula, PageTitle } from '../ui.tsx';

interface Q { id: number; topicId: number; topicTitle: string; prompt: string; options: string[]; page: number | null }
interface Answer { correct: boolean; answerIdx: number; explanation: string | null; confusedWith: string | null }
interface Result { topicId: number; title: string; correct: number; total: number; halfLifeBefore: number | null; halfLifeAfter: number | null; avgConfidence: number }

const CONF = [
  { v: 1, label: 'Guessing' }, { v: 2, label: 'Unsure' }, { v: 3, label: 'Maybe' }, { v: 4, label: 'Fairly sure' }, { v: 5, label: 'Certain' },
];

const isFormula = (s: string) => /[=\\^_]/.test(s) && s.length < 80;

function Start() {
  const [, setParams] = useSearchParams();
  const modes = [
    { mode: 'due', title: 'Due now', text: 'Topics you are closest to forgetting.', icon: Clock },
    { mode: 'danger', title: 'Risky topics', text: 'Where you feel sure but score low.', icon: AlertTriangle },
    { mode: 'contrast', title: 'Tell them apart', text: 'Topics you keep mixing up.', icon: Shuffle },
  ];
  return (
    <div>
      <PageTitle title="Quiz" sub="Short quizzes teach the app how fast you forget. Rate your confidence before you answer." />
      <div className="grid sm:grid-cols-3 gap-4">
        {modes.map(m => (
          <button key={m.mode} onClick={() => setParams({ mode: m.mode, go: '1' })} className="text-left">
            <Card className="p-5 h-full hover:border-act/40 transition-colors">
              <m.icon className="text-act" size={22} />
              <h2 className="text-lg font-bold mt-3">{m.title}</h2>
              <p className="text-ink-soft text-sm mt-1">{m.text}</p>
            </Card>
          </button>
        ))}
      </div>
    </div>
  );
}

export default function Quiz() {
  const [params] = useSearchParams();
  const started = params.get('go') || params.get('topicId') || params.get('subjectId') || params.get('a');
  const [quiz, setQuiz] = useState<{ quizId: string | null; questions: Q[]; mode: string; message?: string; offline?: boolean } | null>(null);
  const offlineAnswers = useRef<(OfflineAnswer & { correct: boolean; topicId: number; topicTitle: string })[]>([]);
  const [i, setI] = useState(0);
  const [conf, setConf] = useState<number | null>(null);
  const [ans, setAns] = useState<Answer | null>(null);
  const [chosen, setChosen] = useState<number | null>(null);
  const [results, setResults] = useState<Result[] | null>(null);
  const [score, setScore] = useState(0);
  const shownAt = useRef(Date.now());

  useEffect(() => {
    if (!started) return;
    const q = new URLSearchParams(params); q.delete('go');
    const start = (r: typeof quiz) => { setQuiz(r); setI(0); setResults(null); setScore(0); offlineAnswers.current = []; shownAt.current = Date.now(); };
    const goOffline = () => {
      const pack = getPack();
      if (!pack) { start({ quizId: null, questions: [], mode: 'due', offline: true, message: "You're offline and no quiz pack is saved on this device yet. Open the app once while online." }); return; }
      const num = (k: string) => Number(params.get(k)) || undefined;
      const questions = offlineQuiz(pack, { mode: params.get('mode') || 'due', topicId: num('topicId'), subjectId: num('subjectId'), a: num('a'), b: num('b') });
      start({ quizId: `offline-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, questions, mode: params.get('mode') || 'due', offline: true });
    };
    if (!navigator.onLine) { goOffline(); return; }
    api(`/quiz?${q.toString()}`).then(start).catch(e => { if (e instanceof TypeError) goOffline(); });
  }, [params, started]);

  if (!started) return <Start />;
  if (!quiz) return <p className="text-ink-soft">Picking questions…</p>;
  if (!quiz.questions.length) return (
    <div><PageTitle title="Quiz" />
      <Empty title={quiz.mode === 'contrast' ? 'No mixed-up topics yet' : quiz.mode === 'danger' ? 'No risky topics right now' : 'Nothing to quiz yet'}>
        {quiz.message ?? 'Keep taking regular quizzes; this list fills in as the app learns about you.'}
        <div className="mt-4"><Link to="/quiz"><Button variant="soft">Back to quiz menu</Button></Link></div>
      </Empty>
    </div>
  );

  if (results) {
    return (
      <div className="max-w-2xl">
        <PageTitle title={`${score} of ${quiz.questions.length} correct`} sub={quiz.offline ? 'Saved on this phone. Your memory model updates as soon as you are back online.' : 'Your memory model is updated.'} />
        <Card className="divide-y divide-mist">
          {results.map(r => {
            const acc = r.correct / r.total;
            const overconfident = r.avgConfidence * 20 - acc * 100 >= 20;
            return (
              <div key={r.topicId} className="px-5 py-4">
                <div className="flex justify-between gap-3">
                  <p className="font-bold">{r.title}</p>
                  <p className="tabular-nums font-bold">{r.correct}/{r.total}</p>
                </div>
                <p className="text-sm text-ink-soft mt-1">
                  {r.halfLifeAfter == null ? 'Saved offline.' : r.halfLifeBefore == null
                    ? `First quiz. Starting memory: about ${r.halfLifeAfter.toFixed(1)} days before it fades to half.`
                    : r.halfLifeAfter >= r.halfLifeBefore
                      ? `Memory got stronger: fades in ${r.halfLifeAfter.toFixed(1)} days now (was ${r.halfLifeBefore.toFixed(1)}).`
                      : `Faded faster than expected: ${r.halfLifeAfter.toFixed(1)} days now (was ${r.halfLifeBefore.toFixed(1)}). It will come up again soon.`}
                </p>
                {overconfident && <p className="text-sm text-storm mt-1 flex items-center gap-1.5"><AlertTriangle size={14} /> You felt {r.avgConfidence.toFixed(1)}/5 sure but scored {Math.round(acc * 100)}%.</p>}
              </div>
            );
          })}
        </Card>
        <div className="flex gap-3 mt-5">
          <Link to="/quiz"><Button variant="soft">Another quiz</Button></Link>
          <Link to="/"><Button>See forecast</Button></Link>
        </div>
      </div>
    );
  }

  const q = quiz.questions[i];
  async function choose(idx: number) {
    if (ans || conf == null) return;
    setChosen(idx);
    const responseMs = Date.now() - shownAt.current;
    let r: Answer;
    if (quiz!.offline) {
      // Graded on the phone; the server re-checks everything when it syncs.
      const pq = q as unknown as PackQuestion;
      const correct = idx === pq.answerIdx;
      const mix = !correct ? pq.optionTopics.find(o => o.idx === idx)?.title ?? null : null;
      r = { correct, answerIdx: pq.answerIdx, explanation: pq.explanation, confusedWith: mix };
      offlineAnswers.current.push({ questionId: q.id, chosenIdx: idx, confidence: conf, responseMs, answeredAt: Date.now(), correct, topicId: q.topicId, topicTitle: q.topicTitle });
    } else {
      r = await api<Answer>('/quiz/answer', { body: { questionId: q.id, chosenIdx: idx, confidence: conf, responseMs, quizId: quiz!.quizId } });
    }
    setAns(r);
    if (r.correct) setScore(s => s + 1);
  }
  async function next() {
    if (i + 1 >= quiz!.questions.length) {
      if (quiz!.offline) {
        const list = offlineAnswers.current;
        queueQuiz({ quizId: quiz!.quizId!, answers: list.map(({ questionId, chosenIdx, confidence, responseMs, answeredAt }) => ({ questionId, chosenIdx, confidence, responseMs, answeredAt })) });
        const by = new Map<number, typeof list>();
        for (const a of list) by.set(a.topicId, [...(by.get(a.topicId) ?? []), a]);
        setResults([...by.values()].map(l => ({ topicId: l[0].topicId, title: l[0].topicTitle, correct: l.filter(a => a.correct).length, total: l.length,
          halfLifeBefore: null, halfLifeAfter: null, avgConfidence: l.reduce((s, a) => s + a.confidence, 0) / l.length })));
        flushOutbox();
        return;
      }
      const r = await api<{ results: Result[] }>('/quiz/finish', { body: { quizId: quiz!.quizId } });
      setResults(r.results);
      refreshPack();
      return;
    }
    setI(i + 1); setConf(null); setAns(null); setChosen(null); shownAt.current = Date.now();
  }

  return (
    <div className="max-w-2xl">
      <div className="flex items-center justify-between mb-2 text-sm text-ink-soft">
        <span>{q.topicTitle}</span>
        <span className="tabular-nums">{i + 1} / {quiz.questions.length}</span>
      </div>
      <div className="h-1.5 bg-mist rounded-full mb-6"><div className="h-full bg-act rounded-full transition-all" style={{ width: `${(i / quiz.questions.length) * 100}%` }} /></div>

      <h1 className="font-display text-2xl md:text-[28px] font-bold leading-snug mb-6">{q.prompt}</h1>

      <div className={`mb-6 transition-opacity ${ans ? 'opacity-60' : ''}`}>
        <p className="text-sm font-bold mb-2">{conf == null ? 'First, how sure are you that you know this?' : 'Your confidence'}</p>
        <div className="grid grid-cols-5 gap-2" role="radiogroup" aria-label="Confidence">
          {CONF.map(c => (
            <button key={c.v} role="radio" aria-checked={conf === c.v} disabled={!!ans} onClick={() => setConf(c.v)}
              className={`rounded-xl border py-2.5 text-center transition-colors ${conf === c.v ? 'border-act bg-act text-on-act' : 'border-mist-deep bg-card hover:border-act'}`}>
              <span className="block font-display text-lg font-bold leading-none">{c.v}</span>
              <span className="block text-[11px] mt-1">{c.label}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="grid gap-2.5">
        {q.options.map((o, k) => {
          const state = !ans ? 'idle' : k === ans.answerIdx ? 'right' : k === chosen ? 'wrong' : 'other';
          const cls = {
            idle: 'border-mist-deep bg-card hover:border-act',
            right: 'border-clear bg-clear-soft',
            wrong: 'border-storm bg-storm-soft',
            other: 'border-mist bg-card opacity-60',
          }[state];
          return (
            <button key={k} onClick={() => choose(k)} disabled={conf == null || !!ans}
              className={`flex items-center gap-3 text-left rounded-xl border-2 px-4 py-3.5 transition-colors disabled:cursor-default ${cls} ${conf == null ? 'opacity-50' : ''}`}>
              <span className="grid place-items-center w-7 h-7 rounded-lg bg-paper font-bold text-sm shrink-0">
                {state === 'right' ? <Check size={16} className="text-clear" /> : state === 'wrong' ? <X size={16} className="text-storm" /> : String.fromCharCode(65 + k)}
              </span>
              <span>{isFormula(o) ? <Formula src={o} /> : o}</span>
            </button>
          );
        })}
      </div>

      {ans && (
        <div className="mt-6">
          <Card className="p-5">
            <p className={`font-bold ${ans.correct ? 'text-clear' : 'text-storm'}`}>{ans.correct ? 'Correct' : 'Not quite'}</p>
            {ans.confusedWith && <p className="text-sm text-haze font-bold mt-1 flex items-center gap-1.5"><Shuffle size={14} /> That answer belongs to {ans.confusedWith}. Noted as a mix-up.</p>}
            {ans.explanation && <p className="mt-2 leading-relaxed">{ans.explanation}</p>}
            {q.page && <p className="text-xs text-ink-soft mt-2">From page {q.page}</p>}
          </Card>
          <Button className="mt-4 w-full sm:w-auto" onClick={next}>{i + 1 >= quiz.questions.length ? 'See results' : 'Next question'}</Button>
        </div>
      )}
    </div>
  );
}
