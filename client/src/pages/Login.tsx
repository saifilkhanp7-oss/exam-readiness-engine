import { useEffect, useRef, useState } from 'react';
import { api, setToken, type User } from '../api.ts';
import { useAuth, ThemeToggle } from '../App.tsx';
import { Button } from '../ui.tsx';

export default function Login() {
  const { setUser } = useAuth();
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [step, setStep] = useState<'email' | 'code'>('email');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [digits, setDigits] = useState<string[]>(Array(6).fill(''));
  const [devOtp, setDevOtp] = useState<string | undefined>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [wait, setWait] = useState(0);
  const boxes = useRef<(HTMLInputElement | null)[]>([]);

  useEffect(() => {
    if (wait <= 0) return;
    const t = setTimeout(() => setWait(w => w - 1), 1000);
    return () => clearTimeout(t);
  }, [wait]);

  async function sendCode(e?: React.FormEvent) {
    e?.preventDefault();
    setError(''); setBusy(true);
    try {
      const r = await api<{ devOtp?: string }>('/auth/request-otp', { body: { mode, email, name } });
      setDevOtp(r.devOtp); setStep('code'); setWait(30); setDigits(Array(6).fill(''));
      setTimeout(() => boxes.current[0]?.focus(), 50);
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }

  async function verify(code: string) {
    setError(''); setBusy(true);
    try {
      const r = await api<{ token: string; user: User }>('/auth/verify-otp', { body: { email, code } });
      setToken(r.token); setUser(r.user);
    } catch (err) {
      setError((err as Error).message); setDigits(Array(6).fill('')); boxes.current[0]?.focus();
    } finally { setBusy(false); }
  }

  function typeDigit(i: number, v: string) {
    const clean = v.replace(/\D/g, '');
    if (clean.length > 1) { // pasted the whole code
      const next = clean.slice(0, 6).split('').concat(Array(6).fill('')).slice(0, 6);
      setDigits(next);
      if (clean.length >= 6) verify(clean.slice(0, 6));
      return;
    }
    const next = [...digits]; next[i] = clean; setDigits(next);
    if (clean && i < 5) boxes.current[i + 1]?.focus();
    if (next.every(d => d)) verify(next.join(''));
  }

  return (
    <div className="min-h-screen grid lg:grid-cols-[1.1fr_1fr]">
      <section className="hidden lg:flex flex-col justify-between bg-solid text-on-solid p-14">
        <span className="font-display font-extrabold text-lg">Exam Readiness Engine</span>
        <div>
          <p className="font-display text-5xl font-extrabold leading-[1.05] max-w-md">Know what you'll remember on exam day.</p>
          <p className="mt-5 text-solid-soft max-w-sm leading-relaxed">Short quizzes teach the app how fast you forget each topic. It plans your revision around your free time and shows a daily readiness forecast for every subject.</p>
          <div className="mt-10 flex gap-6">
            {[['Physics', 78, 'var(--color-clear)'], ['Chemistry', 61, 'var(--color-haze)'], ['Biology', 44, 'var(--color-storm)']].map(([n, v, c]) => (
              <div key={n as string}>
                <p className="font-display text-4xl font-extrabold" style={{ color: c as string }}>{v}%</p>
                <p className="text-sm text-solid-soft">{n}</p>
              </div>
            ))}
          </div>
        </div>
        <p className="text-sm text-solid-soft">Sample forecast</p>
      </section>

      <section className="relative flex items-center justify-center p-6">
        <ThemeToggle className="absolute top-4 right-4" />
        <div className="w-full max-w-sm">
          <p className="lg:hidden font-display font-extrabold text-xl mb-8">Exam Readiness Engine</p>
          {step === 'email' ? (
            <form onSubmit={sendCode}>
              <div className="flex bg-mist rounded-xl p-1 mb-8">
                {(['login', 'signup'] as const).map(m => (
                  <button type="button" key={m} onClick={() => { setMode(m); setError(''); }}
                    className={`flex-1 rounded-lg py-2 text-sm font-bold ${mode === m ? 'bg-card shadow-sm' : 'text-ink-soft'}`}>
                    {m === 'login' ? 'Log in' : 'Sign up'}
                  </button>
                ))}
              </div>
              <h1 className="text-3xl font-extrabold">{mode === 'login' ? 'Welcome back' : 'Create your account'}</h1>
              <p className="text-ink-soft mt-2 mb-6">We'll email you a 6-digit code. No password needed.</p>
              {mode === 'signup' && (
                <label className="block mb-4">
                  <span className="text-sm font-bold">Your name</span>
                  <input value={name} onChange={e => setName(e.target.value)} autoComplete="name" required
                    className="mt-1.5 w-full rounded-xl border border-mist-deep bg-card px-4 py-3 outline-none focus:border-act" placeholder="Saif Khan" />
                </label>
              )}
              <label className="block mb-6">
                <span className="text-sm font-bold">Email</span>
                <input type="email" value={email} onChange={e => setEmail(e.target.value)} autoComplete="email" required
                  className="mt-1.5 w-full rounded-xl border border-mist-deep bg-card px-4 py-3 outline-none focus:border-act" placeholder="you@gmail.com" />
              </label>
              {error && <p className="text-storm text-sm mb-4" role="alert">{error}</p>}
              <Button type="submit" disabled={busy} className="w-full py-3">{busy ? 'Sending…' : 'Send code'}</Button>
            </form>
          ) : (
            <div>
              <h1 className="text-3xl font-extrabold">Check your email</h1>
              <p className="text-ink-soft mt-2 mb-6">Enter the code we sent to <b className="text-ink">{email}</b>. It expires in 5 minutes.</p>
              {devOtp && <p className="mb-4 rounded-xl bg-act-soft text-act text-sm px-4 py-2.5">Dev mode: your code is <b>{devOtp}</b></p>}
              <div className="flex gap-2 mb-5">
                {digits.map((d, i) => (
                  <input key={i} ref={el => { boxes.current[i] = el; }} value={d} inputMode="numeric" autoComplete={i === 0 ? 'one-time-code' : 'off'}
                    aria-label={`Digit ${i + 1}`} maxLength={6} disabled={busy}
                    onChange={e => typeDigit(i, e.target.value)}
                    onKeyDown={e => { if (e.key === 'Backspace' && !d && i > 0) boxes.current[i - 1]?.focus(); }}
                    className="w-full aspect-square text-center font-display text-2xl font-bold rounded-xl border border-mist-deep bg-card outline-none focus:border-act" />
                ))}
              </div>
              {error && <p className="text-storm text-sm mb-4" role="alert">{error}</p>}
              <div className="flex items-center justify-between text-sm">
                <button onClick={() => { setStep('email'); setError(''); }} className="text-ink-soft hover:text-ink">Change email</button>
                <button onClick={() => sendCode()} disabled={wait > 0 || busy} className="font-bold text-act">
                  {wait > 0 ? `Resend in ${wait}s` : 'Resend code'}
                </button>
              </div>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
