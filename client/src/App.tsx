import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { CloudSun, BookOpen, Zap, NotebookPen, CalendarRange, Lightbulb, LogOut, Sun, Moon, WifiOff, RefreshCw } from 'lucide-react';
import { api, getToken, setToken, setUnauthorizedHandler, type User } from './api.ts';
import { useTheme } from './theme.ts';
import { useOffline, flushOutbox, refreshPack, clearOfflineData } from './offline.ts';
import Login from './pages/Login.tsx';
import Forecast from './pages/Forecast.tsx';
import Subjects from './pages/Subjects.tsx';
import SubjectDetail from './pages/SubjectDetail.tsx';
import Quiz from './pages/Quiz.tsx';
import Notes from './pages/Notes.tsx';
import Plan from './pages/Plan.tsx';
import Insights from './pages/Insights.tsx';

interface AuthCtx { user: User | null; setUser: (u: User | null) => void; logout: () => void }
const Auth = createContext<AuthCtx>({ user: null, setUser: () => {}, logout: () => {} });
export const useAuth = () => useContext(Auth);

const NAV = [
  { to: '/', label: 'Forecast', icon: CloudSun },
  { to: '/subjects', label: 'Subjects', icon: BookOpen },
  { to: '/quiz', label: 'Quiz', icon: Zap },
  { to: '/notes', label: 'Notes', icon: NotebookPen },
  { to: '/plan', label: 'Plan', icon: CalendarRange },
  { to: '/insights', label: 'Insights', icon: Lightbulb },
];

/** The sun / moon icon at the top of every page. */
export function ThemeToggle({ className = '' }: { className?: string }) {
  const { theme, toggle } = useTheme();
  const label = theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
  return (
    <button onClick={toggle} aria-label={label} title={label}
      className={`grid place-items-center w-10 h-10 rounded-full border border-mist bg-card text-ink-soft hover:text-ink hover:border-mist-deep transition-colors ${className}`}>
      {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
    </button>
  );
}

function TopBar() {
  const { online, pending } = useOffline();
  return (
    <div className="flex items-center justify-end gap-2 mb-4 md:mb-2 min-h-10 no-print">
      {!online && (
        <span className="mr-auto md:mr-0 inline-flex items-center gap-2 rounded-full bg-haze-soft text-haze text-sm font-bold px-3 py-1.5">
          <WifiOff size={15} /> Offline{pending ? `, ${pending} quiz${pending === 1 ? '' : 'zes'} waiting to sync` : ''}
        </span>
      )}
      {online && pending > 0 && (
        <button onClick={() => flushOutbox()} className="mr-auto md:mr-0 inline-flex items-center gap-2 rounded-full bg-act-soft text-act text-sm font-bold px-3 py-1.5">
          <RefreshCw size={15} /> Sync {pending} offline quiz{pending === 1 ? '' : 'zes'}
        </button>
      )}
      <ThemeToggle />
    </div>
  );
}

function Shell({ children }: { children: ReactNode }) {
  const { user, logout } = useAuth();
  return (
    <div className="min-h-screen md:flex">
      <div className="hidden md:block md:w-60 shrink-0 border-r border-mist bg-card">
      <aside className="flex flex-col px-4 py-6 sticky top-0 h-screen">
        <div className="flex items-center gap-2.5 px-2 mb-8">
          <span className="grid place-items-center w-9 h-9 rounded-full bg-act text-on-act">
            <svg viewBox="0 0 32 32" className="w-5 h-5"><path d="M7 20a9 9 0 0 1 18 0" stroke="currentColor" strokeWidth="3.2" fill="none" strokeLinecap="round" /></svg>
          </span>
          <span className="font-display font-extrabold leading-tight">Exam Readiness<br />Engine</span>
        </div>
        <nav className="flex flex-col gap-1">
          {NAV.map(n => (
            <NavLink key={n.to} to={n.to} end={n.to === '/'}
              className={({ isActive }) => `flex items-center gap-3 rounded-xl px-3 py-2.5 font-bold text-sm transition-colors ${isActive ? 'bg-act-soft text-act' : 'text-ink-soft hover:bg-paper'}`}>
              <n.icon size={18} /> {n.label}
            </NavLink>
          ))}
        </nav>
        <div className="mt-auto px-2">
          <p className="text-sm font-bold truncate">{user?.username}</p>
          <p className="text-xs text-ink-soft truncate">{user?.email}</p>
          <button onClick={logout} className="mt-3 flex items-center gap-2 text-sm text-ink-soft hover:text-storm"><LogOut size={15} /> Log out</button>
        </div>
      </aside>
      </div>
      <main className="flex-1 min-w-0 px-4 pt-4 pb-28 md:px-10 md:pt-6 md:pb-10 max-w-6xl"><TopBar />{children}</main>
      <nav className="md:hidden fixed bottom-0 inset-x-0 bg-card border-t border-mist grid grid-cols-6 pb-[env(safe-area-inset-bottom)] z-20">
        {NAV.map(n => (
          <NavLink key={n.to} to={n.to} end={n.to === '/'}
            className={({ isActive }) => `flex flex-col items-center gap-1 py-2.5 text-[11px] font-bold ${isActive ? 'text-act' : 'text-ink-soft'}`}>
            <n.icon size={20} /> {n.label}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);
  const logout = () => { setToken(null); clearOfflineData(); setUser(null); };
  const remember = (u: User | null) => { try { u ? localStorage.setItem('ere_user', JSON.stringify(u)) : localStorage.removeItem('ere_user'); } catch { /* ignore */ } };
  const setUserAndRemember = (u: User | null) => { remember(u); setUser(u); };

  useEffect(() => {
    setUnauthorizedHandler(() => setUser(null));
    if (!getToken()) { setReady(true); return; }
    // Renews the token every time the app opens, so this device stays logged in.
    api<{ user: User; token: string }>('/auth/me')
      .then(r => { setToken(r.token); setUserAndRemember(r.user); flushOutbox().then(() => refreshPack()); })
      .catch(e => {
        // Offline: open the app with the last known account instead of the login screen.
        if (getToken() && e instanceof TypeError) {
          try { const u = JSON.parse(localStorage.getItem('ere_user') || 'null'); if (u) setUser(u); } catch { /* ignore */ }
        }
      })
      .finally(() => setReady(true));
  }, []);

  if (!ready) return null;
  return (
    <Auth.Provider value={{ user, setUser: setUserAndRemember, logout }}>
      {!user ? <Login /> : (
        <Shell>
          <Routes>
            <Route path="/" element={<Forecast />} />
            <Route path="/subjects" element={<Subjects />} />
            <Route path="/subjects/:id" element={<SubjectDetail />} />
            <Route path="/quiz" element={<Quiz />} />
            <Route path="/notes" element={<Notes />} />
            <Route path="/notes/:id" element={<Notes />} />
            <Route path="/plan" element={<Plan />} />
            <Route path="/insights" element={<Insights />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Shell>
      )}
    </Auth.Provider>
  );
}
