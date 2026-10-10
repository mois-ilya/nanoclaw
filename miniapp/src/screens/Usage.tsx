import { useState } from 'preact/hooks';
import type { Money, UsageView } from '../api/types';
import type { UsageViewX } from '../api/extra';
import { useApp, useApi } from '../ctx';
import { PURPOSE_RU, budgetFraction, dateLong, dayLabel, dateShort, modelLabel, money } from '../format';
import * as tg from '../tg';
import { Hint, Loadable, Row, Screen, Section, Segmented } from '../ui';

function Chart({ daily, tz }: { daily: UsageView['daily']; tz: string }) {
  const [sel, setSel] = useState<number | null>(null);
  const W = 340, H = 132, top = 8, bottom = 18;
  const max = Math.max(...daily.map((d) => d.cost.micros), 1);
  const n = daily.length;
  const gap = n > 20 ? 3 : 5;
  const bw = (W - gap * (n - 1)) / n;
  const cur = sel ?? n - 1;
  const total = daily.reduce((s, d) => s + d.cost.micros, 0);
  const every = n > 20 ? 5 : 2;
  return (
    <div class="card chart">
      <div class="chart-head">
        <div><div class="big mono">{money(daily[cur]?.cost ?? { micros: 0 })}</div><div class="cap">{daily[cur] ? dateShort(`${daily[cur].day}T12:00:00Z`, tz) : ''}</div></div>
        <div style="text-align:right"><div class="cap">за {n} дн.</div><div class="mono" style="font-weight:600">{money(total)}</div></div>
      </div>
      <svg viewBox={`0 0 ${W} ${H + bottom}`} role="img" aria-label="Расход по дням">
        <line class="grid" x1="0" x2={W} y1={H} y2={H} />
        <line class="grid" x1="0" x2={W} y1={top} y2={top} stroke-dasharray="2 3" />
        {daily.map((d, i) => {
          const h = Math.max(d.cost.micros > 0 ? 3 : 1.5, ((H - top) * d.cost.micros) / max);
          const x = i * (bw + gap);
          return (
            <g key={d.day} onClick={() => { tg.haptic.select(); setSel(i); }}>
              <rect x={x - gap / 2} y="0" width={bw + gap} height={H + bottom} fill="transparent" />
              <rect class={`bar-r${i === cur ? ' sel' : ''}`} x={x} y={H - h} width={bw} height={h} rx={Math.min(3, bw / 2)} />
              {(n - 1 - i) % every === 0 && <text class="ax" x={x + bw / 2} y={H + 13} text-anchor="middle">{dayLabel(d.day)}</text>}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function Shares({ items, label }: { items: { key: string; label: string; cost: Money }[]; label: string }) {
  const total = items.reduce((s, i) => s + i.cost.micros, 0) || 1;
  return (
    <Section header={label}>
      {items.map((i) => (
        <div class="row" key={i.key} style="flex-direction:column;align-items:stretch;gap:7px;padding-top:11px;padding-bottom:11px">
          <div style="display:flex;justify-content:space-between;gap:12px"><span>{i.label}</span><span class="mono muted">{money(i.cost)}</span></div>
          <div class="meter"><i style={`width:${Math.max(2, (i.cost.micros / total) * 100)}%`} /></div>
        </div>
      ))}
    </Section>
  );
}

export function Usage() {
  const { me } = useApp();
  const [days, setDays] = useState<number>(14);
  const res = useApi<UsageViewX>(`/api/usage?days=${days}`);
  return (
    <Screen title="Расход" sub="Куда ушли деньги">
      <Loadable res={res} rows={4} hero>
        {(u) => {
          const frac = budgetFraction(u.budget);
          const empty = u.budget.used.micros === 0 && u.daily.every((d) => d.cost.micros === 0);
          return (
            <>
              <Section>
                <div class="card pad" style="border-radius:0">
                  <div style="display:flex;align-items:baseline;justify-content:space-between;gap:12px">
                    <div style="font-size:30px;font-weight:700;letter-spacing:-0.5px" class="mono">{money(u.budget.used)}</div>
                    <div class="muted" style="font-size:15px">{u.budget.limit ? `из ${money(u.budget.limit, { compact: true })}` : 'без лимита'}</div>
                  </div>
                  {frac != null && <div class={`meter ${u.budget.status === 'warn' ? 'warn' : u.budget.status === 'exhausted' ? 'bad' : ''}`} style="margin-top:12px"><i style={`width:${Math.max(frac * 100, 1.5)}%`} /></div>}
                  <div class="muted" style="margin-top:10px;font-size:14px;line-height:1.35">
                    {u.budget.status === 'exhausted' ? 'Лимит на этот месяц исчерпан. ' : u.budget.status === 'warn' ? 'Больше 80% лимита. ' : ''}
                    Сбросится {dateLong(u.budget.periodEnd, me.tz)}{u.pending.micros > 0 && <> · ещё считается {money(u.pending)}</>}
                  </div>
                </div>
              </Section>

              <div style="margin-bottom:12px"><Segmented<number> value={days} options={[{ value: 14, label: '14 дней' }, { value: 30, label: '30 дней' }]} onChange={setDays} /></div>
              <div style="margin-bottom:22px"><Chart key={days} daily={u.daily} tz={me.tz} /></div>

              {empty ? (
                <Hint emoji="🌱">Пока ничего не потрачено. Как только начнём общаться, здесь появится, на что уходят деньги.</Hint>
              ) : (
                <>
                  {u.byModel.length > 0 && <Shares label="По моделям" items={u.byModel.map((m) => ({ key: m.model, label: modelLabel(m.model), cost: m.cost }))} />}
                  {u.byPurpose.length > 0 && <Shares label="На что" items={u.byPurpose.map((p) => ({ key: p.purpose, label: PURPOSE_RU[p.purpose], cost: p.cost }))} />}
                  {u.topTurns.length > 0 && (
                    <Section header="Самые дорогие" footer={u.priceVersion && u.priceVersion !== 'n/a' ? `Цены версии ${u.priceVersion}` : undefined}>
                      {u.topTurns.slice(0, 5).map((t, i) => <Row key={i} title={t.title} sub={dateShort(t.at, me.tz)} value={<span class="mono">{money(t.cost)}</span>} />)}
                    </Section>
                  )}
                </>
              )}
              {(u.voiceSeconds ?? 0) > 0 && <Section><Row title="Голос" value={`${Math.max(1, Math.round((u.voiceSeconds ?? 0) / 60))} мин · бесплатно`} /></Section>}
            </>
          );
        }}
      </Loadable>
    </Screen>
  );
}
