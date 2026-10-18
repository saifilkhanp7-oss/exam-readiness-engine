import katex from 'katex';
import type { ReactNode } from 'react';

export const daysUntil = (ts: number) => Math.max(0, Math.ceil((ts - Date.now()) / 86400000));
export const fmtDate = (ts: number) => new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
export const pct = (x: number) => `${Math.round(x * 100)}%`;

/** Recall 0..1 → memory weather colour. */
export function recallColor(r: number) {
  if (r >= 0.8) return 'var(--color-clear)';
  if (r >= 0.6) return 'var(--color-haze)';
  return 'var(--color-storm)';
}

/** Readiness 0..100 → forecast word. */
export function conditions(readiness: number) {
  if (readiness >= 80) return { word: 'Clear', tone: 'var(--color-clear)' };
  if (readiness >= 65) return { word: 'Mostly clear', tone: 'var(--color-clear)' };
  if (readiness >= 50) return { word: 'Cloudy', tone: 'var(--color-haze)' };
  return { word: 'Stormy', tone: 'var(--color-storm)' };
}

export function RecallBar({ value, width = 'w-24', label }: { value: number; width?: string; label?: string }) {
  return (
    <div className={`flex items-center gap-2 ${width}`} title={label ?? `Recall ${pct(value)}`}>
      <div className="h-1.5 flex-1 rounded-full bg-mist overflow-hidden">
        <div className="h-full rounded-full" style={{ width: `${Math.max(3, value * 100)}%`, background: recallColor(value) }} />
      </div>
      <span className="text-xs tabular-nums text-ink-soft w-8 text-right">{pct(value)}</span>
    </div>
  );
}

export function Button({ children, variant = 'primary', className = '', ...rest }:
  { children: ReactNode; variant?: 'primary' | 'ghost' | 'soft' | 'danger' } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const styles = {
    primary: 'bg-act text-on-act hover:bg-act-hover',
    soft: 'bg-act-soft text-act hover:bg-act-soft-hover',
    ghost: 'text-ink-soft hover:bg-mist',
    danger: 'text-storm hover:bg-storm-soft',
  }[variant];
  return <button className={`inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-bold transition-colors ${styles} ${className}`} {...rest}>{children}</button>;
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <section className={`bg-card rounded-2xl border border-mist ${className}`}>{children}</section>;
}

export function PageTitle({ title, sub, right }: { title: string; sub?: ReactNode; right?: ReactNode }) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-4 mb-6">
      <div>
        <h1 className="text-3xl md:text-4xl font-extrabold">{title}</h1>
        {sub && <p className="text-ink-soft mt-1">{sub}</p>}
      </div>
      {right}
    </header>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-2xl border border-dashed border-mist-deep p-10 text-center">
      <p className="font-display text-xl font-bold">{title}</p>
      <div className="text-ink-soft mt-2">{children}</div>
    </div>
  );
}

/** Typeset LaTeX with KaTeX. Display maths scrolls sideways inside its own box on small screens. */
export function Tex({ src, block = false }: { src: string; block?: boolean }) {
  const html = katex.renderToString(src, { throwOnError: false, displayMode: block, strict: false, trust: false });
  return block
    ? <div className="tex-block overflow-x-auto overflow-y-hidden py-1" dangerouslySetInnerHTML={{ __html: html }} />
    : <span className="katex-wrap" dangerouslySetInnerHTML={{ __html: html }} />;
}

const MATH_UNICODE = /[∇∈∉≤≥≠≈∞→⇒∀∃∂×·∩∪⊂⊆ℓ⋆‖∑∏√λμσθαβγδεπρτφωΔΣΩ]/;

/** A formula from a book: LaTeX, chemistry ("6CO2 + 6H2O") or a word equation ("glucose = lactic acid"). */
export function Formula({ src, block = false }: { src: string; block?: boolean }) {
  const hasTex = /[\\^_{}]/.test(src);
  const looksChem = !hasTex && /[A-Z][a-z]?\d/.test(src);
  const wordy = !hasTex && /[a-z]{3,}/.test(src) && !MATH_UNICODE.test(src);
  if (!looksChem && !wordy) {
    // Chemical formulas (C_6H_{12}O_6) look right upright, not in maths italics.
    const tex = /[A-Z][a-z]?_\{?\d/.test(src) && !/\\frac|\\sqrt|\\sum|\\nabla|\\lambda/.test(src) ? `\\mathrm{${src}}` : src;
    return <Tex src={tex} block={block} />;
  }
  // Digits right after a letter or ")" become subscripts (no regex lookbehind: older iPhones can't parse it).
  const parts: { t: string; sub: boolean }[] = [];
  for (const m of src.matchAll(/([A-Za-z)])(\d+)|[^]/g)) {
    if (m[2] && looksChem) { parts.push({ t: m[1], sub: false }, { t: m[2], sub: true }); }
    else parts.push({ t: m[0], sub: false });
  }
  const el = <span className="font-display">{parts.map((p, i) => (p.sub ? <sub key={i}>{p.t}</sub> : <span key={i}>{p.t}</span>))}</span>;
  return block ? <div className="text-lg py-1">{el}</div> : el;
}

/** Inline formatting: **bold**, `code`, and maths as $...$ or \(...\). */
function inline(s: string, key: number) {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\\\((.+?)\\\)|\$(?!\$)((?:\\\$|[^$])+?)\$)/g;
  let last = 0, m: RegExpExecArray | null, k = 0;
  while ((m = re.exec(s))) {
    if (m.index > last) out.push(s.slice(last, m.index));
    const t = m[0];
    if (t.startsWith('**')) out.push(<strong key={k++}>{inline(t.slice(2, -2), k)}</strong>);
    else if (t.startsWith('`')) out.push(<Formula key={k++} src={t.slice(1, -1)} />);
    else out.push(<Tex key={k++} src={(m[2] ?? m[3]).trim()} />);
    last = m.index + t.length;
  }
  out.push(s.slice(last));
  return <span key={key}>{out}</span>;
}

/** Notes renderer: headings, bullet and numbered lists, tables, paragraphs, inline maths and display maths
 *  ($$...$$ or \[...\], which may span several lines). Written for what the AI step and the offline method produce. */
export function Markdown({ text }: { text: string | null | undefined }) {
  if (!text) return null;
  // Pull display maths out first so line-based parsing doesn't split it.
  const displays: string[] = [];
  const src = text
    .replace(/\$\$([\s\S]+?)\$\$/g, (_, m) => `\n\u0000${displays.push(m.trim()) - 1}\u0000\n`)
    .replace(/\\\[([\s\S]+?)\\\]/g, (_, m) => `\n\u0000${displays.push(m.trim()) - 1}\u0000\n`);
  const blocks: ReactNode[] = [];
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const disp = l.match(/^\s*\u0000(\d+)\u0000\s*$/);
    if (disp) { blocks.push(<Tex key={i} src={displays[Number(disp[1])]} block />); continue; }
    const h = l.match(/^(#{1,4})\s+(.*)$/);
    if (h) { blocks.push(<p key={i} className="font-display font-bold mt-3">{inline(h[2], i)}</p>); continue; }
    if (/^\s*[-*•] /.test(l)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*•] /.test(lines[i])) items.push(lines[i++].replace(/^\s*[-*•] /, ''));
      i--;
      blocks.push(<ul key={i}>{items.map((it, k) => <li key={k}>{inline(it, k)}</li>)}</ul>);
    } else if (/^\s*\d+[.)] /.test(l)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+[.)] /.test(lines[i])) items.push(lines[i++].replace(/^\s*\d+[.)] /, ''));
      i--;
      blocks.push(<ol key={i}>{items.map((it, k) => <li key={k}>{inline(it, k)}</li>)}</ol>);
    } else if (/^\|/.test(l)) {
      const rows: string[][] = [];
      while (i < lines.length && /^\|/.test(lines[i])) {
        if (!/^\|[\s:|-]+\|?\s*$/.test(lines[i])) rows.push(lines[i].split('|').slice(1, -1).map(c => c.trim()));
        i++;
      }
      i--;
      const [head, ...body] = rows;
      if (head) blocks.push(<div key={i} className="overflow-x-auto"><table><thead><tr>{head.map((c, k) => <th key={k}>{inline(c, k)}</th>)}</tr></thead>
        <tbody>{body.map((r, k) => <tr key={k}>{r.map((c, j) => <td key={j}>{inline(c, j)}</td>)}</tr>)}</tbody></table></div>);
    } else if (l.trim()) blocks.push(<p key={i}>{inline(l, i)}</p>);
  }
  return <div className="prose-note">{blocks}</div>;
}
