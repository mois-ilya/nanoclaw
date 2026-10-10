export type RouteName =
  | 'home' | 'memory' | 'memoryFile' | 'prompt' | 'skills' | 'tasks' | 'task' | 'usage'
  | 'connections' | 'settings' | 'requests' | 'friends' | 'friend' | 'guest' | 'system';

export interface Route {
  name: RouteName;
  /** memory: directory; memoryFile: file path; task: id; friend: userId */
  arg?: string;
}

const SIMPLE: Record<string, RouteName> = {
  home: 'home', prompt: 'prompt', skills: 'skills', tasks: 'tasks', usage: 'usage',
  connections: 'connections', settings: 'settings', requests: 'requests', friends: 'friends',
  guest: 'guest', system: 'system',
};

/** `startapp` values that open a screen */
export const START_PARAMS: Record<string, RouteName> = {
  usage: 'usage', requests: 'requests', approvals: 'requests', tasks: 'tasks', connections: 'connections', guest: 'guest',
  friends: 'friends', system: 'system', settings: 'settings', memory: 'memory',
};

export const OWNER_ONLY: ReadonlySet<RouteName> = new Set(['requests', 'friends', 'friend', 'guest', 'system']);

export function parseHash(hash: string): Route {
  const h = hash.replace(/^#\/?/, '');
  const [pathPart, query = ''] = h.split('?');
  const seg = pathPart.split('/').filter(Boolean).map(decodeURIComponent);
  const q = new URLSearchParams(query);
  const [a, b] = seg;
  if (!a) return { name: 'home' };
  if (a === 'memory') {
    if (b === 'file') return { name: 'memoryFile', arg: q.get('path') ?? '' };
    return q.get('dir') ? { name: 'memory', arg: q.get('dir')! } : { name: 'memory' };
  }
  if (a === 'tasks' && b) return { name: 'task', arg: b };
  if (a === 'friends' && b) return { name: 'friend', arg: b };
  if (a in SIMPLE) return { name: SIMPLE[a] };
  return { name: 'home' };
}

export function toHash(r: Route): string {
  const e = (s: string) => encodeURIComponent(s);
  switch (r.name) {
    case 'home': return '#/';
    case 'memory': return r.arg ? `#/memory?dir=${e(r.arg)}` : '#/memory';
    case 'memoryFile': return `#/memory/file?path=${e(r.arg ?? '')}`;
    case 'task': return `#/tasks/${e(r.arg ?? '')}`;
    case 'friend': return `#/friends/${e(r.arg ?? '')}`;
    default: return `#/${r.name}`;
  }
}

function dirOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

export function parentOf(r: Route): Route | null {
  switch (r.name) {
    case 'home': return null;
    case 'memory': return r.arg ? { name: 'memory', arg: dirOf(r.arg) || undefined } : { name: 'home' };
    case 'memoryFile': {
      const d = dirOf(r.arg ?? '');
      return { name: 'memory', arg: d || undefined };
    }
    case 'task': return { name: 'tasks' };
    case 'friend': return { name: 'friends' };
    default: return { name: 'home' };
  }
}

/** BackButton is shown when depth > 0 */
export function depthOf(r: Route): number {
  let d = 0;
  for (let p = parentOf(r); p; p = parentOf(p)) d++;
  return d;
}

export function sameRoute(a: Route, b: Route): boolean {
  return a.name === b.name && (a.arg ?? '') === (b.arg ?? '');
}

export function routeFromStartParam(p: string | undefined | null): Route | null {
  if (!p) return null;
  const n = START_PARAMS[p];
  return n ? { name: n } : null;
}

/**
 * Route to open on launch from a `startapp` deep link, or null to keep the hash route.
 * Telegram launches the app with `#tgWebAppData=…&tgWebAppVersion=…`, which is not an app route,
 * so only a hash starting with `#/` counts as an explicit route.
 */
export function bootRoute(hash: string, startParam: string | undefined | null): Route | null {
  if (hash.startsWith('#/') && hash !== '#/') return null;
  const fromHash = new URLSearchParams(hash.replace(/^#\/?/, '')).get('tgWebAppStartParam');
  return routeFromStartParam(startParam || fromHash);
}
