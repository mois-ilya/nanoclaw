import { useState } from 'preact/hooks';
import type { AccessRequest } from '../api/types';
import { useApp, useApi, invalidate } from '../ctx';
import { ago, money } from '../format';
import * as tg from '../tg';
import { Btn, Empty, Loadable, Screen, Stepper, useAction } from '../ui';

function RequestCard({ r, onDone }: { r: AccessRequest; onDone(): void }) {
  const { api, me, toast } = useApp();
  const act = useAction(toast);
  const [custom, setCustom] = useState(false);
  const [limit, setLimit] = useState(10);
  async function approve(limitUsd?: number) {
    const ok = await act.run(() => api.post(`/api/owner/requests/${encodeURIComponent(r.id)}/approve`, limitUsd == null ? {} : { limitUsd }), `${r.name} получает доступ`);
    if (ok) onDone();
  }
  async function deny() {
    const sure = await tg.confirm({ title: `Отклонить ${r.name}?`, message: 'Человек получит отказ. Позже он сможет попросить доступ снова.', okText: 'Отклонить', destructive: true });
    if (!sure) return;
    const ok = await act.run(() => api.post(`/api/owner/requests/${encodeURIComponent(r.id)}/deny`), 'Отклонено');
    if (ok) onDone();
  }
  return (
    <div class="card pad" style="margin-bottom:12px">
      <div style="display:flex;justify-content:space-between;gap:12px;align-items:baseline">
        <div style="font-size:17px;font-weight:600;overflow-wrap:anywhere">{r.name}{r.username && <span class="muted" style="font-weight:400"> @{r.username}</span>}</div>
        <span class="muted" style="font-size:13px;white-space:nowrap">{ago(r.createdAt, new Date(), me.tz)}</span>
      </div>
      <div class="quote" style="padding:8px 0 14px">«{r.firstMessage}»</div>
      {custom ? (
        <div>
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px"><span class="muted">Лимит в месяц</span>
            <Stepper value={limit} min={1} max={200} step={limit >= 20 ? 5 : 1} format={(v) => money(v * 1_000_000, { compact: true })} onChange={setLimit} /></div>
          <div class="btns"><Btn kind="gray" onClick={() => setCustom(false)} disabled={act.busy}>Назад</Btn><Btn onClick={() => approve(limit)} disabled={act.busy}>Принять</Btn></div>
        </div>
      ) : (
        <>
          <div class="btns"><Btn onClick={() => approve()} disabled={act.busy}>Принять</Btn><Btn kind="danger" onClick={deny} disabled={act.busy}>Отклонить</Btn></div>
          <button class="btn tint block" style="margin-top:10px" onClick={() => { tg.haptic.tap(); setCustom(true); }}>Принять с лимитом…</button>
        </>
      )}
    </div>
  );
}

export function Requests() {
  const res = useApi<AccessRequest[]>('/api/owner/requests');
  const done = () => { invalidate('/api/owner/requests'); invalidate('/api/home'); invalidate('/api/owner/friends'); res.reload(); };
  return (
    <Screen title="Запросы" sub="Кто ждёт моего решения">
      <Loadable res={res} rows={2}>
        {(list) => list.length === 0
          ? <Empty emoji="📭" title="Нет запросов">Когда кто-то попросит доступ к ассистенту, запрос появится здесь и в чате.</Empty>
          : <>{list.map((r) => <RequestCard key={r.id} r={r} onDone={done} />)}</>}
      </Loadable>
    </Screen>
  );
}
