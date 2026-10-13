import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import type { Api } from './api/client';
import type { Me } from './api/types';
import { AppCtx, navigate, navigateBack, useBackButton, useHashRoute, type Ctx } from './ctx';
import { OWNER_ONLY, bootRoute, depthOf, toHash, type Route } from './router';
import { Connections } from './screens/Connections';
import { Connectors } from './screens/Connectors';
import { FriendView, Friends } from './screens/Friends';
import { Guest } from './screens/Guest';
import { Home } from './screens/Home';
import { MemoryFileView, MemoryIndex } from './screens/Memory';
import { Prompt } from './screens/Prompt';
import { Requests } from './screens/Requests';
import { Settings } from './screens/Settings';
import { Skills } from './screens/Skills';
import { System } from './screens/System';
import { TaskView, Tasks } from './screens/Tasks';
import { Usage } from './screens/Usage';
import * as tg from './tg';
import { ErrorBanner, Skeleton, Toast } from './ui';

function Screen({ route, me }: { route: Route; me: Me }) {
  const a = route.arg ?? '';
  if (OWNER_ONLY.has(route.name) && me.role !== 'owner') return <Home />;
  switch (route.name) {
    case 'memory':
      return <MemoryIndex dir={a} />;
    case 'memoryFile':
      return <MemoryFileView path={a} />;
    case 'prompt':
      return <Prompt />;
    case 'skills':
      return <Skills />;
    case 'tasks':
      return <Tasks />;
    case 'task':
      return <TaskView id={a} />;
    case 'usage':
      return <Usage />;
    case 'connections':
      return <Connections />;
    case 'connectors':
      return <Connectors />;
    case 'settings':
      return <Settings />;
    case 'requests':
      return <Requests />;
    case 'friends':
      return <Friends />;
    case 'friend':
      return <FriendView userId={a} />;
    case 'guest':
      return <Guest />;
    case 'system':
      return <System />;
    default:
      return <Home />;
  }
}

export function App({ api }: { api: Api }) {
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [toastState, setToast] = useState<{ msg: string; kind: 'ok' | 'err'; id: number } | null>(null);
  const route = useHashRoute();
  const timer = useRef<number>();

  const boot = useCallback(() => {
    setError(null);
    api.session().then(setMe, (e) => setError(e));
  }, [api]);
  useEffect(boot, [boot]);

  // First open from a `startapp` deep link: jump to the requested screen (UI navigation only, no trust implied).
  useEffect(() => {
    const r = bootRoute(location.hash, tg.startParam());
    if (r) location.replace(toHash(r));
  }, []);

  const toast = useCallback((msg: string, kind: 'ok' | 'err' = 'ok') => {
    setToast({ msg, kind, id: Date.now() });
    clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setToast(null), 2600);
  }, []);

  useBackButton(depthOf(route), navigateBack);

  if (!me) {
    return (
      <main class="screen">
        <header class="title">
          <h1>Кабинет</h1>
        </header>
        {error ? (
          <ErrorBanner
            error={tg.native() || import.meta.env.DEV ? error : 'Открой Кабинет из Telegram'}
            onRetry={boot}
          />
        ) : (
          <Skeleton rows={4} hero />
        )}
      </main>
    );
  }
  const ctx: Ctx = { api, me, setMe, route, go: navigate, back: navigateBack, toast };
  return (
    <AppCtx.Provider value={ctx}>
      <div key={`${route.name}:${route.arg ?? ''}`}>
        <Screen route={route} me={me} />
      </div>
      {toastState && <Toast key={toastState.id} msg={toastState.msg} kind={toastState.kind} />}
    </AppCtx.Provider>
  );
}
