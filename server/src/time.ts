export function validTz(tz: unknown): string {
  const s = String(tz || '');
  try {
    if (s) { new Intl.DateTimeFormat('en-US', { timeZone: s }); return s; }
  } catch { /* fall through */ }
  return 'UTC';
}
