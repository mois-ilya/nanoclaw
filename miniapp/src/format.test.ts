import { describe, expect, it } from 'vitest';
import { ago, budgetFraction, bytes, dateLong, dateShort, modelLabel, money, pluralRu, uptime, whenHuman } from './format';

describe('format', () => {
  it('money', () => {
    expect(money({ micros: 3_100_000 })).toBe('$3.10');
    expect(money({ micros: 0 })).toBe('$0.00');
    expect(money({ micros: 10_000_000 }, { compact: true })).toBe('$10');
    expect(money({ micros: 10_500_000 }, { compact: true })).toBe('$10.50');
  });
  it('plurals', () => {
    expect([1, 2, 5, 11, 21, 22, 25].map((n) => pluralRu(n, 'день', 'дня', 'дней'))).toEqual(['день', 'дня', 'дней', 'дней', 'день', 'дня', 'дней']);
  });
  it('dates in the user tz, ru locale', () => {
    expect(dateLong('2026-10-31T21:30:00Z', 'Europe/Moscow')).toBe('1 ноября');
    expect(dateLong('2026-10-31T21:30:00Z', 'UTC')).toBe('31 октября');
    expect(dateShort('2026-10-09T10:00:00Z', 'Europe/Moscow')).toBe('9 окт');
  });
  it('whenHuman', () => {
    const now = new Date('2026-10-10T08:00:00Z');
    expect(whenHuman('2026-10-10T15:00:00Z', 'Europe/Moscow', now)).toBe('сегодня, 18:00');
    expect(whenHuman('2026-10-11T05:30:00Z', 'Europe/Moscow', now)).toBe('завтра, 08:30');
    expect(whenHuman('2026-10-30T05:30:00Z', 'Europe/Moscow', now)).toBe('30 окт, 08:30');
  });
  it('ago', () => {
    const now = new Date('2026-10-10T12:00:00Z');
    expect(ago('2026-10-10T11:59:40Z', now)).toBe('только что');
    expect(ago('2026-10-10T11:35:00Z', now)).toBe('25 мин назад');
    expect(ago('2026-10-10T09:00:00Z', now)).toBe('3 часа назад');
    expect(ago('2026-10-09T09:00:00Z', now, 'UTC')).toBe('вчера');
  });
  it('bytes / uptime / budget', () => {
    expect(bytes(412)).toBe('412 Б');
    expect(bytes(2048)).toBe('2.0 КБ');
    expect(uptime(9 * 86400 + 4 * 3600)).toBe('9 д 4 ч');
    const b = { limit: { micros: 10_000_000 }, used: { micros: 3_000_000 }, reserved: { micros: 1_000_000 }, periodStart: '', periodEnd: '', status: 'ok' as const };
    expect(budgetFraction(b)).toBeCloseTo(0.4);
    expect(budgetFraction({ ...b, limit: null })).toBeNull();
    expect(budgetFraction({ ...b, used: { micros: 20_000_000 } })).toBe(1);
  });
  it('modelLabel', () => {
    expect(modelLabel('claude-sonnet-4-5')).toBe('Sonnet 4.5');
    expect(modelLabel('claude-opus-4-1')).toBe('Opus 4.1');
    expect(modelLabel('gpt-x')).toBe('gpt-x');
  });
});
