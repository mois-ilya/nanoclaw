import { useEffect, useState } from 'preact/hooks';
import type { EgressView } from '../api/types';
import type { ConnectionX } from '../api/extra';
import { useApp, useApi, invalidate } from '../ctx';
import { ago, dateShort } from '../format';
import * as tg from '../tg';
import { ActionBar, Btn, Chip, Hint, Loadable, Row, Screen, Section, Segmented, useAction } from '../ui';

interface Data { connections: ConnectionX[]; egress: EgressView }

const STATUS: Record<ConnectionX['status'], [('ok' | 'warn' | 'bad' | undefined), string]> = {
  not_connected: [undefined, 'Не подключено'], connecting: ['warn', 'Подключаюсь…'], connected: ['ok', 'Подключено'], error: ['bad', 'Ошибка'], expired: ['bad', 'Ключ истёк'],
};

export function Connections() {
  const { api, me, toast } = useApp();
  const res = useApi<Data>('/api/connections');
  const act = useAction(toast);
  const [key, setKey] = useState('');
  const ts = res.data?.connections.find((c) => c.id === 'tailscale');
  // The owner's connector is run by the server: the backend rejects key changes and revocation (409), so the SPA offers neither.
  const managed = ts?.managed ?? me.role === 'owner';
  const needsKey = me.role === 'owner' && !managed && !!ts && ts.status !== 'connected' && ts.status !== 'connecting';
  const connecting = ts?.status === 'connecting';

  useEffect(() => {
    if (!connecting) return;
    const t = setInterval(res.reload, 2500);
    return () => clearInterval(t);
  }, [connecting]); // eslint-disable-line react-hooks/exhaustive-deps

  async function saveKey() {
    const ok = await tg.confirm({ title: 'Сохранить ключ?', message: 'Ключ сохранится в зашифрованном виде. Потом его нельзя будет посмотреть — только заменить или отозвать.', okText: 'Сохранить' });
    if (!ok) return;
    const done = await act.run(() => api.put('/api/connections/tailscale/key', { key: key.trim() }), 'Ключ сохранён');
    if (done) { setKey(''); invalidate('/api/connections'); res.reload(); }
  }
  async function revoke() {
    const ok = await tg.confirm({ title: 'Отозвать доступ?', message: 'Ассистент перестанет подключаться к Tailscale. Ключ будет удалён.', okText: 'Отозвать', destructive: true });
    if (!ok) return;
    const done = await act.run(() => api.del('/api/connections/tailscale'), 'Доступ отозван');
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

  const dirty = key.trim().length > 0;
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
              <Section header="Tailscale" footer={managed ? 'Подключением управляет сервер: ключ здесь вводить не нужно.' : 'Ключ только записывается: после сохранения его нигде не видно, и вернуть его нельзя.'}>
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
                {c?.keySavedAt && <Row title="Ключ" value={<span class="mono">●●●● … сохранён {dateShort(c.keySavedAt, me.tz)}</span>} />}
                {c?.keyExpiresAt && c.status === 'connected' && <Row title="Действует до" value={dateShort(c.keyExpiresAt, me.tz)} />}
                {needsKey && (
                  <input class="field" style="border-top:0.5px solid var(--sep)" type="password" inputMode="text" autocomplete="off" autocapitalize="off" spellcheck={false} placeholder={c?.status === 'not_connected' ? 'Вставить ключ' : 'Вставить новый ключ'} value={key} onInput={(e) => setKey((e.target as HTMLInputElement).value)} aria-label="Ключ Tailscale" />
                )}
                {c?.status === 'connected' && !managed && (
                  <input class="field" style="border-top:0.5px solid var(--sep)" type="password" autocomplete="off" autocapitalize="off" spellcheck={false} placeholder="Заменить ключ" value={key} onInput={(e) => setKey((e.target as HTMLInputElement).value)} aria-label="Новый ключ Tailscale" />
                )}
                {connecting && <Row title={<span class="muted">Устанавливаю соединение…</span>} />}
              </Section>

              {c && c.status !== 'not_connected' && (
                <div class="btns" style="margin:-8px 0 22px">
                  <Btn kind="tint" onClick={reconnect} disabled={act.busy}>Проверить снова</Btn>
                  {!managed && !tg.supportsSecondary() && <Btn kind="danger" onClick={revoke} disabled={act.busy}>Отозвать</Btn>}
                </div>
              )}
              </>)}

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
      <ActionBar
        main={{ text: 'Сохранить ключ', visible: dirty && me.role === 'owner' && !managed, progress: act.busy, onClick: saveKey }}
        secondary={{ text: 'Отозвать', visible: me.role === 'owner' && !managed && !!ts && ts.status !== 'not_connected' && !dirty, destructive: true, nativeOnly: true, onClick: revoke }}
      />
    </Screen>
  );
}
