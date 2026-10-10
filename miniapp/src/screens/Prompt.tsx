import type { PromptView } from '../api/types';
import { useApi, useApp } from '../ctx';
import { ago } from '../format';
import { interceptLinks, renderMarkdown } from '../markdown';
import { Loadable, Screen, Svg } from '../ui';

export function Prompt() {
  const { me } = useApp();
  const res = useApi<PromptView>('/api/prompt');
  return (
    <Screen title="Инструкции" sub="Как я себя веду">
      <div class="info">Чтобы изменить — скажи в чате: <q>отвечай короче</q></div>
      <Loadable res={res} rows={3}>
        {(p) => (
          <>
            <div class="section"><div class="card">
              {p.layers.map((l) => (
                <details class="layer" key={l.id} open={l.id === 'personal'}>
                  <summary class="row has-icon tap" style="min-height:56px">
                    <span class={`ico c-${l.id === 'platform' ? 'gray' : l.id === 'personal' ? 'blue' : 'orange'}`}><Svg name={l.locked ? 'lock' : l.id === 'skills' ? 'skills' : 'prompt'} class="" /></span>
                    <div class="body"><div class="t">{l.title}</div><div class="s">{l.source}{l.locked ? ' · только чтение' : ''}</div></div>
                    <Svg name="chev" class="chev i" />
                  </summary>
                  <div class="layer-body">
                    {l.markdown.trim()
                      ? <div class="md" onClick={interceptLinks} dangerouslySetInnerHTML={{ __html: renderMarkdown(l.markdown) }} />
                      : <p class="muted" style="margin:12px 0 0;font-size:15px">Пока пусто. Скажи в чате, как тебе удобнее: <q>называй меня на «ты»</q></p>}
                  </div>
                </details>
              ))}
            </div></div>
            <p class="section-f" style="margin-top:-8px">Собрано {ago(p.composedAt, new Date(), me.tz)}</p>
          </>
        )}
      </Loadable>
    </Screen>
  );
}
