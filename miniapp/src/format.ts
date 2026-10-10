import type { Budget, Money } from './api/types';

export function money(m: Money | number, opts: { compact?: boolean } = {}): string {
  const usd = (typeof m === 'number' ? m : m.micros) / 1_000_000;
  if (opts.compact && Math.abs(usd - Math.round(usd)) < 0.005) return `$${Math.round(usd)}`;
  return `$${usd.toFixed(2)}`;
}

export function pluralRu(n: number, one: string, few: string, many: string): string {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}

export function count(n: number, one: string, few: string, many: string): string {
  return `${n} ${pluralRu(n, one, few, many)}`;
}

function dtf(tz: string, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  try {
    return new Intl.DateTimeFormat('ru-RU', { timeZone: tz, ...opts });
  } catch {
    return new Intl.DateTimeFormat('ru-RU', opts);
  }
}

/** «9 окт» */
export function dateShort(iso: string, tz: string): string {
  return dtf(tz, { day: 'numeric', month: 'short' }).format(new Date(iso)).replace('.', '');
}

/** «1 ноября» */
export function dateLong(iso: string, tz: string): string {
  return dtf(tz, { day: 'numeric', month: 'long' }).format(new Date(iso));
}

export function timeOfDay(iso: string, tz: string): string {
  return dtf(tz, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
}

function ymd(d: Date, tz: string): string {
  return dtf(tz, { year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

function dayDiff(iso: string, now: Date, tz: string): number {
  const a = Date.parse(ymd(new Date(iso), tz).split('.').reverse().join('-'));
  const b = Date.parse(ymd(now, tz).split('.').reverse().join('-'));
  return Math.round((a - b) / 86_400_000);
}

/** «сегодня, 09:00» · «завтра, 09:00» · «пн, 09:00» · «12 окт, 09:00» */
export function whenHuman(iso: string, tz: string, now: Date = new Date()): string {
  const diff = dayDiff(iso, now, tz);
  const t = timeOfDay(iso, tz);
  if (diff === 0) return `сегодня, ${t}`;
  if (diff === 1) return `завтра, ${t}`;
  if (diff === -1) return `вчера, ${t}`;
  if (diff > 1 && diff < 7) {
    return `${dtf(tz, { weekday: 'short' }).format(new Date(iso))}, ${t}`;
  }
  return `${dateShort(iso, tz)}, ${t}`;
}

/** «только что» · «5 мин назад» · «вчера» · «3 окт» */
export function ago(iso: string, now: Date = new Date(), tz = 'UTC'): string {
  const s = (now.getTime() - Date.parse(iso)) / 1000;
  if (s < 60) return 'только что';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} мин назад`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} ${pluralRu(h, 'час', 'часа', 'часов')} назад`;
  const d = dayDiff(iso, now, tz);
  if (d === -1) return 'вчера';
  if (d > -7) return `${-d} ${pluralRu(-d, 'день', 'дня', 'дней')} назад`;
  return dateShort(iso, tz);
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} Б`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} КБ`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} МБ`;
  return `${(n / 1024 ** 3).toFixed(1)} ГБ`;
}

export function uptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d} д ${h} ч`;
  if (h > 0) return `${h} ч ${m} мин`;
  return `${m} мин`;
}

/** Share of the limit already used or reserved, 0..1. null when there is no limit. */
export function budgetFraction(b: Budget): number | null {
  if (!b.limit || b.limit.micros <= 0) return null;
  return Math.min(1, (b.used.micros + b.reserved.micros) / b.limit.micros);
}

export function budgetLine(b: Budget, tz: string): string {
  const resets = `сбросится ${dateLong(b.periodEnd, tz)}`;
  if (!b.limit) return `${money(b.used)} за месяц · без лимита`;
  return `${money(b.used)} из ${money(b.limit, { compact: true })} · ${resets}`;
}

export function dayLabel(day: string): string {
  const [, m, d] = day.split('-');
  return `${Number(d)}.${m}`;
}

export const PURPOSE_RU: Record<string, string> = { chat: 'Чат', task: 'Задачи', voice: 'Голос', guest: 'Гость' };

export function modelLabel(id: string): string {
  const m = id.match(/(opus|sonnet|haiku)[-\s]*([\d.-]*)/i);
  if (!m) return id;
  const name = m[1][0].toUpperCase() + m[1].slice(1).toLowerCase();
  const ver = m[2].replace(/-$/, '').replace(/-/g, '.');
  return ver ? `${name} ${ver}` : name;
}
