import type { SystemViewX } from '../api/extra';
import { useApi, useApp } from '../ctx';
import { ago, bytes, dateShort, money, uptime } from '../format';
import * as tg from '../tg';
import { Chip, Loadable, Row, Screen, Section } from '../ui';

/** Connector status from the backend -> chip kind + Russian label (never raw English). */
function connectorChip(status: string): ['ok' | 'warn' | 'bad', string] {
  switch (status) {
    case 'ok': return ['ok', 'В порядке'];
    case 'expired': return ['bad', 'Ключ истёк'];
    case 'down': return ['bad', 'Недоступно'];
    case 'not_configured': return ['warn', 'Не настроено'];
    default: return ['warn', 'Неизвестно'];
  }
}

const COLORS = ['#3390ec', '#34c759', '#ff9500', '#af52de', '#ff2d55', '#30b0c7'];

export function System() {
  const { me } = useApp();
  const res = useApi<SystemViewX>('/api/owner/system');
  return (
    <Screen title="Система" sub="Здоров ли сервер и сколько я плачу">
      <Loadable res={res} rows={5} hero>
        {(s) => {
          const memLimited = s.slice.memMax > 0;
          const mem = memLimited ? s.slice.memUsed / s.slice.memMax : 0;
          const total = s.spendByUser.reduce((a, u) => a + u.cost.micros, 0);
          const capped = s.globalCap.micros > 0;
          const capFrac = capped ? total / s.globalCap.micros : 0;
          return (
            <>
              <div class="kv">
                <div class="tile"><div class="k">Версия</div><div class="vv">{s.version}</div></div>
                <div class="tile"><div class="k">Работает</div><div class="vv">{uptime(s.uptimeS)}</div></div>
                <div class="tile"><div class="k">Шлюз</div><div class="vv" style="font-size:17px;padding-top:3px"><Chip kind={s.gateway === 'ok' ? 'ok' : 'bad'}>{s.gateway === 'ok' ? 'Работает' : 'Не отвечает'}</Chip></div></div>
                <div class="tile"><div class="k">Ошибок за 7 дней</div><div class="vv">{s.errors7d}</div></div>
              </div>

              {(s.buildId || s.deployedAt || s.grafanaUrl) && (
                <Section header="Сборка">
                  {s.buildId && <Row title="Сборка" value={<span class="mono">{s.buildId.slice(0, 12)}</span>} />}
                  {s.deployedAt && <Row title="Выкатили" value={dateShort(s.deployedAt, me.tz)} />}
                  {s.grafanaUrl && <Row title="Открыть Grafana" chevron onClick={() => tg.openLink(s.grafanaUrl!)} />}
                </Section>
              )}

              <Section header="Ресурсы">
                <div class="row" style="flex-direction:column;align-items:stretch;gap:8px">
                  <div style="display:flex;justify-content:space-between"><span>Память</span><span class="mono muted">{memLimited ? `${bytes(s.slice.memUsed)} из ${bytes(s.slice.memMax)}` : `${bytes(s.slice.memUsed)} · без ограничения`}</span></div>
                  {memLimited && <div class={`meter${mem > 0.9 ? ' bad' : mem > 0.75 ? ' warn' : ''}`}><i style={`width:${Math.min(100, mem * 100)}%`} /></div>}
                </div>
                <Row title="Контейнеры" value={s.containers.max > 0 ? `${s.containers.running} из ${s.containers.max}` : `${s.containers.running}`} />
              </Section>

              <Section header="Расход по людям" footer={capped ? `Потолок на всех: ${money(s.globalCap, { compact: true })} · потрачено ${Math.round(capFrac * 100)}%` : 'Потолок на всех не задан'}>
                <div class="card pad" style="border-radius:0 ;padding-bottom:6px">
                  <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:12px"><span class="mono" style="font-size:24px;font-weight:700">{money({ micros: total })}</span><span class="muted">за месяц</span></div>
                  <div class="stack">{s.spendByUser.map((u, i) => <i key={u.name} title={u.name} style={`flex:${Math.max(u.cost.micros, 1)};background:${COLORS[i % COLORS.length]}`} />)}</div>
                </div>
                {s.spendByUser.map((u, i) => <Row key={u.name} title={<span style="display:inline-flex;align-items:center;gap:9px"><span class="dot" style={`background:${COLORS[i % COLORS.length]}`} />{u.name}</span>} value={<span class="mono">{money(u.cost)}</span>} />)}
              </Section>

              <Section header="Подключения">
                {s.connectors.map((c) => <Row key={c.tenant} title={c.tenant} right={<Chip kind={connectorChip(c.status)[0]}>{connectorChip(c.status)[1]}</Chip>} />)}
              </Section>

              {s.recentAudit && (
                <Section header="Журнал действий" footer="Последние записи владельца и системы.">
                  {s.recentAudit.length === 0 ? <Row title={<span class="muted">Пока пусто</span>} /> : s.recentAudit.map((a, i) => (
                    <Row key={i} title={a.action} sub={`${a.actor}${a.target ? ` → ${a.target}` : ''} · ${ago(a.at, new Date(), me.tz)}`} />
                  ))}
                </Section>
              )}
            </>
          );
        }}
      </Loadable>
    </Screen>
  );
}
