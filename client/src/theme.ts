// Light / dark theme. The choice is remembered on this device; with no choice the device setting is used.
import { useEffect, useState } from 'react';

export type Theme = 'light' | 'dark';
const KEY = 'ere_theme';

const stored = (): Theme | null => { try { const v = localStorage.getItem(KEY); return v === 'light' || v === 'dark' ? v : null; } catch { return null; } };
const system = (): Theme => (window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');

function apply(t: Theme) {
  document.documentElement.dataset.theme = t;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', t === 'dark' ? '#0D1320' : '#F7F8FB');
}

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(() => stored() ?? system());
  useEffect(() => { apply(theme); }, [theme]);
  useEffect(() => {
    // Follow the device until the user picks one.
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
    const onChange = () => { if (!stored()) setTheme(system()); };
    mq?.addEventListener('change', onChange);
    return () => mq?.removeEventListener('change', onChange);
  }, []);
  const toggle = () => setTheme(t => {
    const next: Theme = t === 'dark' ? 'light' : 'dark';
    try { localStorage.setItem(KEY, next); } catch { /* storage blocked */ }
    return next;
  });
  return { theme, toggle };
}
