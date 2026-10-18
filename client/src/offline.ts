// Offline support: a quiz pack is kept on the phone so quizzes work without a connection,
// and answers given offline wait in an outbox until the phone is back online.
import { useEffect, useState } from 'react';
import { api } from './api.ts';

const PACK = 'ere_pack';
const OUTBOX = 'ere_outbox';

export interface PackQuestion {
  id: number; topicId: number; topicTitle: string; prompt: string; options: string[];
  answerIdx: number; explanation: string | null; page: number | null;
  optionTopics: { idx: number; title: string | null }[];
}
export interface Pack {
  builtAt: number;
  topics: { id: number; title: string; subjectId: number; subject: string; recall: number | null; danger: boolean }[];
  questions: PackQuestion[];
}
export interface OfflineAnswer { questionId: number; chosenIdx: number; confidence: number; responseMs: number; answeredAt: number }
export interface OfflineQuiz { quizId: string; answers: OfflineAnswer[] }

const read = <T,>(k: string, fallback: T): T => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) as T : fallback; } catch { return fallback; } };
const write = (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* full or blocked */ } };

export const getPack = () => read<Pack | null>(PACK, null);
export const outbox = () => read<OfflineQuiz[]>(OUTBOX, []);

export async function refreshPack() {
  try { write(PACK, await api<Pack>('/quiz/pack')); } catch { /* offline: keep the old pack */ }
}

export function queueQuiz(q: OfflineQuiz) {
  write(OUTBOX, [...outbox().filter(x => x.quizId !== q.quizId), q]);
  window.dispatchEvent(new Event('ere-outbox'));
}

let flushing = false;
export async function flushOutbox(): Promise<number> {
  const items = outbox();
  if (!items.length || flushing || !navigator.onLine) return 0;
  flushing = true;
  try {
    const r = await api<{ applied: number; skipped: number }>('/quiz/sync', { body: { quizzes: items } });
    // Remove only what we sent; anything queued meanwhile stays.
    const sent = new Set(items.map(i => i.quizId));
    write(OUTBOX, outbox().filter(x => !sent.has(x.quizId)));
    window.dispatchEvent(new Event('ere-outbox'));
    if (r.applied) await refreshPack();
    return r.applied;
  } catch { return 0; } finally { flushing = false; }
}

export function clearOfflineData() {
  try { localStorage.removeItem(PACK); localStorage.removeItem(OUTBOX); localStorage.removeItem('ere_user'); } catch { /* ignore */ }
  if ('caches' in window) caches.keys().then(keys => keys.filter(k => k.startsWith('ere-api')).forEach(k => caches.delete(k)));
}

/** Online status and how many offline quizzes are waiting to sync. */
export function useOffline() {
  const [online, setOnline] = useState(navigator.onLine);
  const [pending, setPending] = useState(outbox().length);
  useEffect(() => {
    const up = () => { setOnline(true); flushOutbox(); };
    const down = () => setOnline(false);
    const count = () => setPending(outbox().length);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    window.addEventListener('ere-outbox', count);
    return () => { window.removeEventListener('online', up); window.removeEventListener('offline', down); window.removeEventListener('ere-outbox', count); };
  }, []);
  return { online, pending };
}

/** Pick questions from the pack the same way the server does. */
export function offlineQuiz(pack: Pack, opts: { mode: string; topicId?: number; subjectId?: number; a?: number; b?: number; n?: number }) {
  const n = opts.n ?? 8;
  let topics = pack.topics.filter(t => !opts.subjectId || t.subjectId === opts.subjectId);
  if (opts.topicId) topics = topics.filter(t => t.id === opts.topicId);
  else if (opts.mode === 'danger') topics = topics.filter(t => t.danger);
  else if (opts.mode === 'contrast' && opts.a && opts.b) topics = topics.filter(t => t.id === opts.a || t.id === opts.b);
  else topics = [...topics].sort((x, y) => (x.recall ?? 2) - (y.recall ?? 2)).slice(0, 4);
  const ids = new Set(topics.map(t => t.id));
  const qs = pack.questions.filter(q => ids.has(q.topicId)).sort(() => Math.random() - 0.5);
  const per = new Map<number, number>();
  const picked: PackQuestion[] = [];
  for (const q of qs) {
    if (picked.length >= n) break;
    const c = per.get(q.topicId) ?? 0;
    if (c >= Math.ceil(n / Math.max(1, ids.size)) + 1) continue;
    per.set(q.topicId, c + 1);
    picked.push(q);
  }
  return picked;
}
