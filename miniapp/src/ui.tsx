import type { ComponentChildren, JSX } from 'preact';
import { useState } from 'preact/hooks';
import { ApiError } from './api/client';
import { useMainButton, useSecondaryButton, type Resource } from './ctx';
import * as tg from './tg';

/* ---------- icons ---------- */
const P: Record<string, string> = {
  home: 'M3 11l9-8 9 8v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1z',
  memory: 'M4 4.5A2.5 2.5 0 0 1 6.5 2H20v17H6.5A2.5 2.5 0 0 0 4 21.5zM4 19.5A2.5 2.5 0 0 1 6.5 17H20',
  prompt: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M8 13h8M8 17h5',
  skills: 'M13 2L3 14h9l-1 8 10-12h-9z',
  tasks: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zM12 6v6l4 2',
  usage: 'M18 20V10M12 20V4M6 20v-6',
  connections: 'M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7',
  settings: 'M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6',
  requests: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM19 8v6M22 11h-6',
  friends: 'M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75',
  guest: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z',
  system: 'M2 3h20v7H2zM2 14h20v7H2zM6 6.5h.01M6 17.5h.01',
  chev: 'M9 6l6 6-6 6',
  lock: 'M5 11h14v10H5zM8 11V7a4 4 0 0 1 8 0v4',
  check: 'M20 6L9 17l-5-5',
  x: 'M18 6L6 18M6 6l12 12',
  folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  alert: 'M12 9v4M12 17h.01M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
  pause: 'M6 4h4v16H6zM14 4h4v16h-4z',
  play: 'M6 4l14 8-14 8z',
  trash: 'M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6',
  file: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6',
};
export type IconName = keyof typeof P;
export function Svg({ name, class: cls = 'i' }: { name: IconName; class?: string }) {
  return <svg class={cls} viewBox="0 0 24 24" aria-hidden="true"><path d={P[name]} /></svg>;
}
export function Ico({ name, color }: { name: IconName; color: string }) {
  return <span class={`ico c-${color}`}><Svg name={name} class="" /></span>;
}

/* ---------- layout ---------- */
export function Screen({ title, sub, children, bar }: { title: string; sub?: string; children: ComponentChildren; bar?: boolean }) {
  return (
    <main class={`screen${bar ? ' has-bar' : ''}`}>
      <header class="title"><h1>{title}</h1>{sub && <p>{sub}</p>}</header>
      {children}
    </main>
  );
}

export function Section({ header, action, footer, children }: { header?: string; action?: { text: string; onClick(): void }; footer?: ComponentChildren; children: ComponentChildren }) {
  return (
    <section class="section">
      {header && <h2 class="section-h"><span>{header}</span>{action && <button class="act" onClick={() => { tg.haptic.tap(); action.onClick(); }}>{action.text}</button>}</h2>}
      <div class="card">{children}</div>
      {footer && <p class="section-f">{footer}</p>}
    </section>
  );
}

interface RowProps {
  icon?: { name: IconName; color: string };
  title: ComponentChildren;
  sub?: ComponentChildren;
  value?: ComponentChildren;
  right?: ComponentChildren;
  chevron?: boolean;
  danger?: boolean;
  center?: boolean;
  disabled?: boolean;
  onClick?: () => void;
}
export function Row(p: RowProps) {
  const cls = `row${p.icon ? ' has-icon' : ''}${p.danger ? ' danger' : ''}${p.center ? ' center' : ''}`;
  const inner = (
    <>
      {p.icon && <Ico name={p.icon.name} color={p.icon.color} />}
      <div class="body"><div class="t">{p.title}</div>{p.sub != null && p.sub !== '' && <div class="s">{p.sub}</div>}</div>
      {p.value != null && <span class="v">{p.value}</span>}
      {p.right}
      {p.chevron && <Svg name="chev" class="chev i" />}
    </>
  );
  if (p.onClick) return <button class={cls} disabled={p.disabled} onClick={() => { tg.haptic.tap(); p.onClick!(); }}>{inner}</button>;
  return <div class={cls}>{inner}</div>;
}

/* ---------- states ---------- */
export function Skeleton({ rows = 4, hero }: { rows?: number; hero?: boolean }) {
  return (
    <div aria-busy="true" aria-label="Загрузка">
      {hero && <div class="sk" style="height:84px;border-radius:12px;margin-bottom:22px" />}
      <div class="card">
        {Array.from({ length: rows }, (_, i) => (
          <div class="sk-row" key={i}>
            <div class="sk" style="width:30px;height:30px;border-radius:8px" />
            <div style="flex:1"><div class="sk" style={`height:14px;width:${55 + ((i * 17) % 35)}%`} /><div class="sk" style="height:11px;width:35%;margin-top:7px" /></div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function ErrorBanner({ error, onRetry }: { error: ApiError | Error | string; onRetry(): void }) {
  const msg = typeof error === 'string' ? error : error instanceof ApiError && error.code === 'network' ? 'Нет связи с сервером' : error.message;
  return (
    <div class="banner" role="alert">
      <span class="m">Не удалось загрузить · {msg}</span>
      <button onClick={() => { tg.haptic.tap(); onRetry(); }}>Повторить</button>
    </div>
  );
}

export function Empty({ emoji, title, children }: { emoji: string; title: string; children?: ComponentChildren }) {
  return <div class="empty"><div class="emoji" aria-hidden="true">{emoji}</div><h2>{title}</h2>{children && <p>{children}</p>}</div>;
}
export function Hint({ emoji = '💬', children }: { emoji?: string; children: ComponentChildren }) {
  return <div class="hint-card"><span class="emoji" aria-hidden="true">{emoji}</span><div>{children}</div></div>;
}

/** Skeleton while there is nothing to show, error banner on failure, children once data exists. */
export function Loadable<T>({ res, rows, hero, children }: { res: Resource<T>; rows?: number; hero?: boolean; children(d: T): ComponentChildren }) {
  return (
    <>
      {res.error && <ErrorBanner error={res.error} onRetry={res.reload} />}
      {res.data === undefined ? (res.error ? null : <Skeleton rows={rows} hero={hero} />) : children(res.data)}
    </>
  );
}

/* ---------- controls ---------- */
export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange(v: boolean): void; label: string; disabled?: boolean }) {
  return (
    <span class="hit">
      <button class="switch" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} onClick={() => { tg.haptic.select(); onChange(!checked); }} />
    </span>
  );
}

export function Segmented<T extends string | number>({ value, options, onChange, disabled }: { value: T; options: { value: T; label: string }[]; onChange(v: T): void; disabled?: boolean }) {
  return (
    <div class="seg" role="group">
      {options.map((o) => (
        <button key={String(o.value)} aria-pressed={o.value === value} disabled={disabled} onClick={() => { if (o.value !== value) { tg.haptic.select(); onChange(o.value); } }}>{o.label}</button>
      ))}
    </div>
  );
}

export function Stepper({ value, min, max, step, format, onChange }: { value: number; min: number; max: number; step: number; format(v: number): string; onChange(v: number): void }) {
  return (
    <div class="stepper">
      <button aria-label="Меньше" disabled={value <= min} onClick={() => { tg.haptic.select(); onChange(Math.max(min, value - step)); }}>−</button>
      <span class="n">{format(value)}</span>
      <button aria-label="Больше" disabled={value >= max} onClick={() => { tg.haptic.select(); onChange(Math.min(max, value + step)); }}>+</button>
    </div>
  );
}

export function Btn({ children, kind, onClick, disabled, block }: { children: ComponentChildren; kind?: 'tint' | 'gray' | 'danger'; onClick(): void; disabled?: boolean; block?: boolean }) {
  return <button class={`btn${kind ? ` ${kind}` : ''}${block ? ' block' : ''}`} disabled={disabled} onClick={() => { tg.haptic.tap(); onClick(); }}>{children}</button>;
}

export function Chip({ kind, children }: { kind?: 'ok' | 'warn' | 'bad'; children: ComponentChildren }) {
  return <span class={`chip${kind ? ` ${kind}` : ''}`}>{children}</span>;
}

export function Ring({ fraction, status, label }: { fraction: number | null; status: 'ok' | 'warn' | 'exhausted'; label?: string }) {
  const r = 32, c = 2 * Math.PI * r;
  const f = fraction ?? 0;
  return (
    <div class={`ring ${status}`} role="img" aria-label={label}>
      <svg viewBox="0 0 80 80"><circle class="trk" cx="40" cy="40" r={r} fill="none" stroke-width="9" /><circle class="val" cx="40" cy="40" r={r} fill="none" stroke-width="9" stroke-linecap="round" stroke-dasharray={String(c)} stroke-dashoffset={String(c * (1 - f))} /></svg>
      <div class="pct">{fraction == null ? '∞' : `${Math.round(f * 100)}%`}</div>
    </div>
  );
}

/** Native MainButton/SecondaryButton in Telegram; an in-page bottom bar elsewhere (and on clients without SecondaryButton). */
export function ActionBar({ main, secondary }: { main: { text: string; visible: boolean; progress?: boolean; destructive?: boolean; onClick(): void }; secondary?: { text: string; visible: boolean; destructive?: boolean; nativeOnly?: boolean; onClick(): void } }) {
  const mainFallback = useMainButton(main);
  const secFallback = useSecondaryButton(secondary ?? { text: '', visible: false, onClick: () => {} });
  const showMain = mainFallback && main.visible;
  const showSec = secFallback && !!secondary?.visible && !secondary.nativeOnly;
  if (!showMain && !showSec) return null;
  return (
    <div class="bar"><div class="bar-in">
      {showSec && <button class={`btn ${secondary!.destructive ? 'danger' : 'gray'}`} onClick={() => { tg.haptic.tap(); secondary!.onClick(); }}>{secondary!.text}</button>}
      {showMain && <button class="btn" disabled={main.progress} onClick={() => { tg.haptic.tap(); main.onClick(); }}>{main.progress ? 'Сохраняю…' : main.text}</button>}
    </div></div>
  );
}

/* ---------- toast ---------- */
export function Toast({ msg, kind }: { msg: string; kind: 'ok' | 'err' }) {
  return <div class={`toast${kind === 'err' ? ' err' : ''}`} role="status">{msg}</div>;
}

/** Hook: run an async write with a busy flag, haptics and an error toast. */
export function useAction(toast: (m: string, k?: 'ok' | 'err') => void) {
  const [busy, setBusy] = useState(false);
  /** Resolves true when the write succeeded. */
  async function run(fn: () => Promise<unknown>, okMsg?: string): Promise<boolean> {
    setBusy(true);
    try {
      await fn();
      tg.haptic.success();
      if (okMsg) toast(okMsg);
      return true;
    } catch (e) {
      tg.haptic.error();
      toast(e instanceof ApiError ? e.message || (e.code === 'forbidden' ? 'Это действие недоступно' : 'Не получилось. Попробуй ещё раз') : 'Не получилось. Попробуй ещё раз', 'err');
      return false;
    } finally {
      setBusy(false);
    }
  }
  return { busy, run };
}

export type { JSX };
