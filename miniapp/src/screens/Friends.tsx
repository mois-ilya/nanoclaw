import { useEffect, useState } from 'preact/hooks';
import type { EgressView, Friend } from '../api/types';
import { useApp, useApi, invalidate, useClosingConfirmation } from '../ctx';
import { ago, budgetFraction, money } from '../format';
import * as tg from '../tg';
import { ActionBar, Chip, Empty, ErrorBanner, Loadable, Row, Screen, Section, Segmented, Skeleton, Stepper, useAction } from '../ui';

const dotFor = (f: Friend) => (f.state === 'ready' ? (f.budget.status === 'exhausted' ? 'bad' : 'ok') : f.state === 'paused' ? 'warn' : f.state === 'provisioning' ? 'busy' : 'bad');
const stateLabel: Record<Friend['state'], string> = { ready: 'Работает', paused: 'Пауза', provisioning: 'Готовится', provisioning_failed: 'Не запустился' };

export function Friends() {
  const { go, me } = useApp();
  const res = useApi<Friend[]>('/api/owner/friends');
  return (
    <Screen title="Друзья" sub="Кто чем пользуется">
      <Loadable res={res} rows={4}>
        {(list) => list.length === 0 ? (
          <Empty emoji="👥" title="Пока никого">Друзья появятся здесь после того, как ты примешь их запросы.</Empty>
        ) : (
          <Section footer="Содержимое переписки и памяти друзей не показывается — только расход и активность.">
            {list.map((f) => (
              <Row
                key={f.userId}
                title={<span style="display:inline-flex;align-items:center;gap:8px"><span class={`dot ${dotFor(f)}`} />{f.name}</span>}
                sub={<>{f.lastActiveAt ? `Активность ${ago(f.lastActiveAt, new Date(), me.tz)}` : 'Ещё не писал(а)'}{f.container === 'running' ? ' · работает сейчас' : ''}</>}
                value={<span class="mono">{money(f.budget.used)}{f.budget.limit ? ` / ${money(f.budget.limit, { compact: true })}` : ''}</span>}
                chevron
                onClick={() => go({ name: 'friend', arg: f.userId })}
              />
            ))}
          </Section>
        )}
      </Loadable>
    </Screen>
  );
}

export function FriendView({ userId }: { userId: string }) {
  const { api, me, back, toast } = useApp();
  const res = useApi<Friend[]>('/api/owner/friends');
  const conn = useApi<{ egress: EgressView }>('/api/connections');
  const homeReady = conn.data?.egress.residentialAvailable ?? true; // unknown yet: leave the toggle usable
  const f = res.data?.find((x) => x.userId === userId);
  const act = useAction(toast);
  const saved = f?.budget.limit ? Math.round(f.budget.limit.micros / 1_000_000) : 0;
  const [limit, setLimit] = useState<number | null>(null);
  const [typed, setTyped] = useState('');
  useEffect(() => { if (f) setLimit(saved); }, [f?.userId, saved]); // eslint-disable-line react-hooks/exhaustive-deps
  const dirty = limit != null && f != null && limit !== saved;
  useClosingConfirmation(dirty);
  const refresh = () => { invalidate('/api/owner/friends'); invalidate('/api/home'); res.reload(); };

  async function saveLimit() {
    if (limit == null || !f) return;
    const ok = await tg.confirm({ title: 'Изменить лимит?', message: `${f.name}: ${money(saved * 1_000_000, { compact: true })} → ${money(limit * 1_000_000, { compact: true })} в месяц.`, okText: 'Сохранить' });
    if (!ok) return;
    if (await act.run(() => api.patch(`/api/owner/friends/${encodeURIComponent(userId)}`, { limitUsd: limit }), 'Лимит обновлён')) refresh();
  }
  async function setEgress(egress: Friend['egress']) {
    if (await act.run(() => api.patch(`/api/owner/friends/${encodeURIComponent(userId)}`, { egress }))) refresh();
  }
  async function togglePause() {
    if (!f) return;
    const verb = f.state === 'paused' ? 'resume' : 'pause';
    if (verb === 'pause') {
      const ok = await tg.confirm({ title: `Приостановить ${f.name}?`, message: 'Новые запросы не будут выполняться, задачи встанут на паузу.', okText: 'Приостановить' });
      if (!ok) return;
    }
    if (await act.run(() => api.post(`/api/owner/friends/${encodeURIComponent(userId)}/${verb}`), verb === 'pause' ? 'Приостановлено' : 'Снова работает')) refresh();
  }
  async function remove() {
    if (!f) return;
    const ok = await tg.confirm({ title: `Удалить ${f.name}?`, message: 'Доступ, память и задачи будут удалены без возможности восстановления.', okText: 'Удалить', destructive: true });
    if (!ok) return;
    if (await act.run(() => api.del(`/api/owner/friends/${encodeURIComponent(userId)}`, { confirmName: f.name }), 'Друг удалён')) { refresh(); back(); }
  }

  const frac = f ? budgetFraction(f.budget) : null;
  return (
    <Screen title={f?.name ?? 'Друг'} sub={f ? (f.username ? `@${f.username}` : undefined) : undefined} bar={dirty}>
      {res.error && <ErrorBanner error={res.error} onRetry={res.reload} />}
      {!f && !res.error && <Skeleton rows={4} />}
      {!f && res.data && <Empty emoji="🤷" title="Не нашёл такого друга" />}
      {f && limit != null && (
        <>
          <div class="kv">
            <div class="tile"><div class="k">Потрачено</div><div class="vv mono">{money(f.budget.used)}</div></div>
            <div class="tile"><div class="k">Статус</div><div class="vv" style="font-size:17px;padding-top:3px"><Chip kind={f.state === 'ready' ? 'ok' : f.state === 'paused' ? 'warn' : f.state === 'provisioning' ? undefined : 'bad'}>{stateLabel[f.state]}</Chip></div></div>
          </div>
          <Section header="Лимит в месяц" footer={frac != null ? `Использовано ${Math.round(frac * 100)}%` : undefined}>
            <div class="row" style="justify-content:space-between"><span>Лимит</span><Stepper value={limit} min={1} max={200} step={limit >= 20 ? 5 : 1} format={(v) => money(v * 1_000_000, { compact: true })} onChange={setLimit} /></div>
          </Section>
          <Section header="Выход в интернет" footer={homeReady ? undefined : 'Домашний выход не настроен: сначала подключи Tailscale в «Подключениях».'}>
            <div class="pad-seg"><Segmented value={f.egress} disabled={act.busy || (!homeReady && f.egress !== 'residential')} options={[{ value: 'residential', label: 'Через дом' }, { value: 'direct', label: 'Напрямую' }]} onChange={setEgress} /></div>
          </Section>
          <Section header="Состояние" footer="Только метаданные. Переписку и память друга ты не видишь.">
            <Row title="Контейнер" value={f.container === 'running' ? 'Работает' : 'Спит'} />
            <Row title="Активность" value={f.lastActiveAt ? ago(f.lastActiveAt, new Date(), me.tz) : '—'} />
          </Section>
          <Section>
            <Row center title={f.state === 'paused' ? 'Возобновить' : 'Приостановить'} onClick={togglePause} disabled={act.busy} />
          </Section>
          <Section header="Удаление" footer={`Чтобы удалить, введи имя: ${f.name}`}>
            <input class="field" placeholder={f.name} value={typed} onInput={(e) => setTyped((e.target as HTMLInputElement).value)} aria-label="Подтверждение имени" autocomplete="off" />
            <Row center danger title="Удалить друга" onClick={remove} disabled={typed.trim() !== f.name || act.busy} />
          </Section>
        </>
      )}
      <ActionBar main={{ text: 'Сохранить', visible: dirty, progress: act.busy, onClick: saveLimit }} />
    </Screen>
  );
}
