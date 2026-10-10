import type { MemoryFile, MemoryTree } from '../api/types';
import { useApp, useApi, invalidate } from '../ctx';
import { ago, bytes, count } from '../format';
import { renderMarkdown, interceptLinks, memoryDoc, splitFrontmatter } from '../markdown';
import * as tg from '../tg';
import { Btn, ErrorBanner, Hint, Loadable, Row, Screen, Section, Skeleton, useAction } from '../ui';

const dirOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

function Md({ src }: { src: string }) {
  return <div class="md" onClick={interceptLinks} dangerouslySetInnerHTML={{ __html: renderMarkdown(splitFrontmatter(src).body) }} />;
}

export function MemoryIndex({ dir }: { dir: string }) {
  const { go, me } = useApp();
  const res = useApi<MemoryTree>('/api/memory');
  const showIndex = !dir && !!res.data?.entries.some((e) => e.path === 'index.md');
  const idx = useApi<MemoryFile>(showIndex ? `/api/memory/file?path=${encodeURIComponent('index.md')}` : null);
  const title = dir ? dir.split('/').pop()! : 'Память';
  return (
    <Screen title={title} sub={dir ? undefined : 'Что обо мне известно'}>
      <Loadable res={res} rows={4}>
        {(t) => {
          const items = t.entries.filter((e) => dirOf(e.path) === dir && !(e.path === 'index.md' && !dir));
          const childCount = (d: string) => t.entries.filter((e) => e.kind === 'file' && e.path.startsWith(`${d}/`)).length;
          if (t.entries.length === 0) {
            return <Hint emoji="🧠">Ещё ничего не запомнил. Напиши в чат: <q>запомни, что я люблю чай без сахара</q> — и это появится здесь.</Hint>;
          }
          return (
            <>
              {showIndex && idx.data && (
                <Section header="Главное"><div class="card pad" style="border-radius:0"><Md src={idx.data.markdown} /></div></Section>
              )}
              {showIndex && !idx.data && !idx.error && <div style="margin-bottom:22px"><Skeleton rows={2} /></div>}
              {items.length > 0 && (
                <Section header={dir ? undefined : 'Заметки'} footer={t.truncated ? 'Показана только часть записей' : undefined}>
                  {items.map((e) => e.kind === 'dir' ? (
                    <Row key={e.path} icon={{ name: 'folder', color: 'blue' }} title={e.title} sub={count(childCount(e.path), 'запись', 'записи', 'записей')} chevron onClick={() => go({ name: 'memory', arg: e.path })} />
                  ) : (
                    <Row key={e.path} icon={{ name: 'file', color: 'indigo' }} title={e.title} sub={`${ago(e.updatedAt, new Date(), me.tz)} · ${bytes(e.size)}`} chevron onClick={() => go({ name: 'memoryFile', arg: e.path })} />
                  ))}
                </Section>
              )}
              <p class="section-f" style="margin-top:-8px;padding-bottom:12px">Чтобы изменить память, скажи в чате: <q>запомни…</q> или <q>забудь…</q></p>
            </>
          );
        }}
      </Loadable>
    </Screen>
  );
}

export function MemoryFileView({ path }: { path: string }) {
  const { api, me, toast } = useApp();
  const res = useApi<MemoryFile>(`/api/memory/file?path=${encodeURIComponent(path)}`);
  const act = useAction(toast);
  const doc = res.data ? memoryDoc(res.data.markdown, path) : null;
  const name = doc?.title ?? path.split('/').pop()!.replace(/\.md$/, '');
  const body = doc?.body ?? '';
  async function forget() {
    const ok = await tg.confirm({ title: 'Забыть это?', message: 'Я передам ассистенту просьбу забыть эту запись. Он подтвердит в чате.', okText: 'Забыть', destructive: true });
    if (!ok) return;
    const done = await act.run(() => api.post('/api/memory/forget', { path }), 'Попросил ассистента забыть');
    if (done) invalidate('/api/memory');
  }
  return (
    <Screen title={name} sub={res.data ? `Обновлено ${ago(res.data.updatedAt, new Date(), me.tz)}` : undefined}>
      {res.error && <ErrorBanner error={res.error} onRetry={res.reload} />}
      {!res.data && !res.error && <Skeleton rows={3} />}
      {res.data && (
        <>
          <Section footer={res.data.truncated ? 'Файл длинный — показано начало' : undefined}>
            <div class="card pad" style="border-radius:0"><Md src={body} /></div>
          </Section>
          <Btn kind="danger" block onClick={forget} disabled={act.busy}>Забыть это</Btn>
        </>
      )}
    </Screen>
  );
}
