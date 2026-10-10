import { render } from 'preact';
import './styles.css';
import { App } from './App';
import { createApi } from './api/client';
import * as tg from './tg';

tg.init();
tg.applyTheme();
tg.watchTheme();

async function start() {
  let api = createApi({ getInitData: tg.initData });
  // Outside Telegram (no signed initData) the dev server serves a mock backend; production never bundles it.
  if (import.meta.env.DEV && !tg.native()) {
    const { createMockFetch } = await import('./api/mock');
    api = createApi({ getInitData: () => 'mock', fetchImpl: createMockFetch(location.search) });
  }
  render(<App api={api} />, document.getElementById('app')!);
}
void start();
