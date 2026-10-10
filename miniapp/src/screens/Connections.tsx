import { useState } from 'preact/hooks';
import type { EgressView } from '../api/types';
import type { ConnectionX, SttView } from '../api/extra';
import { useApp, useApi, invalidate } from '../ctx';
import { ago, dateShort } from '../format';
import * as tg from '../tg';
import { ActionBar, Btn, Chip, Hint, Loadable, Row, Screen, Section, Segmented, useAction } from '../ui';

interface Data { connections: ConnectionX[]; egress: EgressView; stt?: SttView }

const STATUS: Record<ConnectionX['status'], [('ok' | 'warn' | 'bad' | undefined), string]> = {
  not_connected: [undefined, 'Не подключено'], connecting: ['warn', 'Подключаюсь…'], connected: ['ok', 'Подключено'], error: ['bad', 'Ошибка'], expired: ['bad', 'Ключ истёк'],
};

export function Connections() {
  const { api, me, toast } = useApp();
  const res = useApi<Data>('/api/connections');
  const act = useAction(toast);
  const [groq, setGroq] = useState('');
  async function saveGroq() {
    const done = await act.run(() => api.put('/api/owner/secrets/groq-key', { key: groq.trim() }), 'Ключ сохранён');
    if (done) { setGroq(''); invalidate('/api/connections'); res.reload(); }
  }
  async function removeGroq() {
    const ok = await tg.confirm({ title: 'Удалить ключ?', message: 'Голос будет распознаваться локальной моделью, она медленнее.', okText: 'Удалить', destructive: true });
    if (!ok) return;
    const done = await act.run(() => api.del('/api/owner/secrets/groq-key'), 'Ключ удалён');
    if (done) { invalidate('/api/connections'); res.reload(); }
  }
  async function reconnect() {
    const done = await act.run(() => api.post('/api/connections/tailscale/reconnect'), 'Проверяю…');
    if (done) { invalidate('/api/connections'); res.reload(); }
  }
  async function setRoute(route: EgressView['route']) {
    const d = res.data;
    if (!d) return;
    res.set({ ...d, egress: { ...d.egress, route } });
    const ok = await act.run(() => api.put('/api/egress', { route }));
    if (!ok) res.set(d); else invalidate('/api/connections');
  }

  const groqDirty = groq.trim().length > 0 && me.role === 'owner';
  const dirty = groqDirty;
  return (
    <Screen title="Подключения" sub="Ключи и доступ" bar={dirty}>
      <Loadable res={res} rows={3}>
        {(d) => {
          const c = d.connections.find((x) => x.id === 'tailscale');
          const [kind, label] = c ? STATUS[c.status] : STATUS.not_connected;
          const isOwner = me.role === 'owner';
          const showEgress = d.egress.residentialAvailable || isOwner;
          return (
            <>
              {!isOwner && !showEgress && <Hint emoji="🔌">Здесь появятся подключения. Свой домашний выход пока настраивает владелец.</Hint>}
              {isOwner && (<>
              <Section header="Tailscale" footer="Подключением управляет сервер: ключ здесь вводить не нужно.">
                <Row icon={{ name: 'connections', color: 'teal' }} title="Домашняя сеть" sub="Доступ к твоим устройствам через Tailscale" right={<Chip kind={kind}>{label}</Chip>} />
                {c?.message && c.status !== 'connected' && <div class="quote" style="padding-top:2px;color:var(--danger)">{c.message}</div>}
                {c && c.status === 'connected' && (
                  <>
                    {c.node && <Row title="Узел" value={c.node} />}
                    {c.exitNode && <Row title="Выходной узел" value={<span style="display:inline-flex;align-items:center;gap:7px"><span class={`dot ${c.exitNodeOnline ? 'ok' : 'bad'}`} />{c.exitNode}</span>} />}
                    {c.routes && c.routes.length > 0 && <Row title="Маршруты" value={c.routes.join(', ')} />}
                    {c.lastCheckAt && <Row title="Проверено" value={ago(c.lastCheckAt, new Date(), me.tz)} />}
                  </>
                )}
              </Section>

              {c && c.status !== 'not_connected' && (
                <div class="btns" style="margin:-8px 0 22px">
                  <Btn kind="tint" onClick={reconnect} disabled={act.busy}>Проверить снова</Btn>
                </div>
              )}
              </>)}

              {isOwner && d.stt && (
                <Section header="Распознавание голоса" footer="Ключ Groq: console.groq.com → API Keys. Он только записывается: после сохранения его нигде не видно. Если Groq недоступен, голос распознаёт локальная модель.">
                  <Row icon={{ name: 'connections', color: 'teal' }} title="Голосовые сообщения"
                    sub={d.stt.provider === 'groq'
                      ? (d.stt.groqKey?.source === 'server' ? 'Groq · ключ задан сервером' : `Groq · ключ сохранён ${d.stt.groqKey?.savedAt ? dateShort(d.stt.groqKey.savedAt, me.tz) : ''}`.trim())
                      : d.stt.provider === 'local' ? 'Локальная модель (медленнее)' : 'Распознавание не настроено'}
                    right={<Chip kind={d.stt.provider === 'groq' ? 'ok' : d.stt.provider === 'none' ? 'bad' : undefined}>{d.stt.provider === 'groq' ? 'Groq' : d.stt.provider === 'local' ? 'Локально' : 'Выкл.'}</Chip>} />
                  {d.stt.groqKeyInvalid && <div class="quote" style="padding-top:2px;color:var(--danger)">Groq отклонил ключ, пока работает локальная модель. Замени ключ.</div>}
                  <input class="field" style="border-top:0.5px solid var(--sep)" type="password" autocomplete="off" autocapitalize="off" spellcheck={false} placeholder={d.stt.groqKey ? 'Заменить ключ Groq' : 'Вставить ключ Groq'} value={groq} onInput={(e) => setGroq((e.target as HTMLInputElement).value)} aria-label="Ключ Groq" />
                  <div class="btns" style="padding:8px 16px">
                    <Btn kind="tint" onClick={saveGroq} disabled={act.busy || !groqDirty}>Сохранить</Btn>
                    {d.stt.groqKey?.source === 'miniapp' && <Btn kind="danger" onClick={removeGroq} disabled={act.busy}>Удалить</Btn>}
                  </div>
                </Section>
              )}

              {showEgress && (
                <Section header="Выход в интернет" footer={d.egress.residentialAvailable
                  ? 'Через дом: запросы ассистента в интернет идут через твой домашний узел, сайты видят домашний адрес. Напрямую: с сервера ассистента.'
                  : 'Доступно, когда подключён Tailscale с выходным узлом.'}>
                  <div class="pad-seg">
                    <Segmented value={d.egress.route} disabled={!d.egress.residentialAvailable || act.busy}
                      options={[{ value: 'residential', label: 'Через дом' }, { value: 'direct', label: 'Напрямую' }]} onChange={setRoute} />
                  </div>
                </Section>
              )}
            </>
          );
        }}
      </Loadable>
      <ActionBar main={{ text: 'Сохранить ключ Groq', visible: groqDirty, progress: act.busy, onClick: saveGroq }} />
    </Screen>
  );
}
