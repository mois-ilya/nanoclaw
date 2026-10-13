import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OWNER_ONLY, bootRoute, depthOf, parentOf, parseHash, routeFromStartParam, toHash } from './router';

describe('router', () => {
  it('parses and formats hashes (round trip)', () => {
    for (const h of [
      '#/',
      '#/memory',
      '#/memory?dir=people%2Fclose',
      '#/memory/file?path=people%2Fanya.md',
      '#/tasks',
      '#/tasks/t1',
      '#/friends/77',
      '#/guest',
      '#/system',
      '#/connectors',
    ]) {
      expect(toHash(parseHash(h))).toBe(h);
    }
  });
  it('unknown hash falls back to home', () => {
    expect(parseHash('#/nope')).toEqual({ name: 'home' });
    expect(parseHash('')).toEqual({ name: 'home' });
  });
  it('depth drives BackButton visibility', () => {
    expect(depthOf(parseHash('#/'))).toBe(0);
    expect(depthOf(parseHash('#/tasks'))).toBe(1);
    expect(depthOf(parseHash('#/tasks/t1'))).toBe(2);
    expect(depthOf(parseHash('#/memory?dir=a%2Fb'))).toBe(3);
    expect(depthOf(parseHash('#/memory/file?path=a%2Fb.md'))).toBe(3);
  });
  it('parents', () => {
    expect(parentOf(parseHash('#/tasks/t1'))).toEqual({ name: 'tasks' });
    expect(parentOf(parseHash('#/memory/file?path=index.md'))).toEqual({ name: 'memory', arg: undefined });
    expect(parentOf(parseHash('#/memory/file?path=a%2Fb.md'))).toEqual({ name: 'memory', arg: 'a' });
    expect(parentOf({ name: 'home' })).toBeNull();
  });
  it('startapp deep links', () => {
    expect(routeFromStartParam('usage')).toEqual({ name: 'usage' });
    expect(routeFromStartParam('requests')).toEqual({ name: 'requests' });
    expect(routeFromStartParam('evil')).toBeNull();
    expect(routeFromStartParam(undefined)).toBeNull();
  });
  it('connectors is an owner-only screen with a start param', () => {
    expect(OWNER_ONLY.has('connectors')).toBe(true);
    expect(depthOf(parseHash('#/connectors'))).toBe(1);
    expect(routeFromStartParam('connectors')).toEqual({ name: 'connectors' });
  });
  it('boot route ignores the Telegram launch hash but honours an explicit app route', () => {
    const tgHash = '#tgWebAppData=query_id%3DAA&tgWebAppVersion=8.0&tgWebAppPlatform=ios';
    expect(bootRoute(tgHash, 'friends')).toEqual({ name: 'friends' });
    expect(bootRoute(tgHash, 'approvals')).toEqual({ name: 'requests' });
    expect(bootRoute(tgHash + '&tgWebAppStartParam=usage', undefined)).toEqual({ name: 'usage' });
    expect(bootRoute('', 'usage')).toEqual({ name: 'usage' });
    expect(bootRoute('#/', 'usage')).toEqual({ name: 'usage' });
    expect(bootRoute('#/tasks', 'usage')).toBeNull();
    expect(bootRoute(tgHash, undefined)).toBeNull();
    expect(bootRoute(tgHash, 'evil')).toBeNull();
  });
  it('every webApp value used by src/nc is a known start param', () => {
    const dir = fileURLToPath(new URL('../../src/nc', import.meta.url));
    const used = new Set<string>();
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.ts') && !n.endsWith('.test.ts'))) {
      for (const m of readFileSync(join(dir, f), 'utf8').matchAll(/webApp:\s*'([a-z]+)'/g)) used.add(m[1]);
    }
    expect(used.size).toBeGreaterThan(0);
    for (const v of used) expect(routeFromStartParam(v), v).not.toBeNull();
  });
});
