import { createContext } from 'preact';
import { useContext, useEffect, useRef, useState, useCallback } from 'preact/hooks';
import type { Api } from './api/client';
import { ApiError } from './api/client';
import type { Me } from './api/types';
import { parseHash, toHash, parentOf, sameRoute, type Route } from './router';
import * as tg from './tg';

export interface Ctx { api: Api; me: Me; setMe(me: Me): void; route: Route; go(r: Route): void; back(): void; toast(msg: string, kind?: 'ok' | 'err'): void; }
export const AppCtx = createContext<Ctx>(null as unknown as Ctx);
export const useApp = (): Ctx => useContext(AppCtx);

/* ---------- navigation ---------- */
let pushes = 0;
export function navigate(r: Route): void {
  if (sameRoute(r, parseHash(location.hash))) return;
  pushes++;
  location.hash = toHash(r);
}
export function navigateBack(): void {
  const cur = parseHash(location.hash);
  const parent = parentOf(cur);
  if (!parent) return;
  if (pushes > 0) { pushes--; history.back(); } else location.replace(toHash(parent));
}
export function useHashRoute(): Route {
  const [r, setR] = useState<Route>(() => parseHash(location.hash));
  useEffect(() => {
    const on = () => { setR(parseHash(location.hash)); window.scrollTo(0, 0); };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return r;
}

/* ---------- data ---------- */
// Stale-while-revalidate: a screen shows the last known data instantly, then refreshes.
const cache = new Map<string, unknown>();
export function invalidate(prefix?: string): void {
  for (const k of [...cache.keys()]) if (!prefix || k.startsWith(prefix)) cache.delete(k);
}

export interface Resource<T> { data: T | undefined; error: ApiError | null; loading: boolean; reload(): void; set(v: T): void; }

export function useApi<T>(path: string | null): Resource<T> {
  const { api } = useApp();
  const [tick, setTick] = useState(0);
  const [state, setState] = useState<{ data: T | undefined; error: ApiError | null; loading: boolean }>(() => ({
    data: path ? (cache.get(path) as T | undefined) : undefined, error: null, loading: !!path,
  }));
  useEffect(() => {
    if (!path) return;
    let live = true;
    const cached = cache.get(path) as T | undefined;
    setState((s) => ({ data: cached ?? undefined, error: null, loading: cached === undefined || s.error !== null }));
    api.get<T>(path).then(
      (d) => { cache.set(path, d); if (live) setState({ data: d, error: null, loading: false }); },
      (e) => { if (live) setState({ data: cached ?? undefined, error: e instanceof ApiError ? e : new ApiError('internal', 'Что-то пошло не так'), loading: false }); },
    );
    return () => { live = false; };
  }, [api, path, tick]);
  // A Mini App left open goes stale: refetch the current resource when it becomes visible again.
  useEffect(() => {
    if (!path) return;
    const on = () => { if (document.visibilityState === 'visible') setTick((t) => t + 1); };
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, [path]);
  const reload = useCallback(() => { setState((s) => ({ ...s, loading: true, error: null })); setTick((t) => t + 1); }, []);
  const set = useCallback((v: T) => { if (path) cache.set(path, v); setState((s) => ({ ...s, data: v })); }, [path]);
  return { ...state, reload, set };
}

/* ---------- Telegram native bindings ---------- */
export function useBackButton(depth: number, cb: () => void): void {
  const ref = useRef(cb); ref.current = cb;
  useEffect(() => tg.bindBack(depth > 0, () => ref.current()), [depth]);
}

export interface BottomSpec { text: string; visible: boolean; progress?: boolean; destructive?: boolean; onClick: () => void }
/** Returns true when no native button exists, so the screen should render an in-page bar instead. */
export function useMainButton(spec: BottomSpec): boolean {
  const ref = useRef(spec.onClick); ref.current = spec.onClick;
  useEffect(() => tg.bindMain({ ...spec, onClick: () => ref.current() }),
    [spec.text, spec.visible, spec.progress, spec.destructive]); // eslint-disable-line react-hooks/exhaustive-deps
  return !tg.native();
}
export function useSecondaryButton(spec: BottomSpec): boolean {
  const ref = useRef(spec.onClick); ref.current = spec.onClick;
  useEffect(() => tg.bindSecondary({ ...spec, onClick: () => ref.current() }),
    [spec.text, spec.visible, spec.progress, spec.destructive]); // eslint-disable-line react-hooks/exhaustive-deps
  return !tg.supportsSecondary();
}

export function useClosingConfirmation(dirty: boolean): void {
  useEffect(() => { tg.setClosingConfirmation(dirty); return () => tg.setClosingConfirmation(false); }, [dirty]);
}
