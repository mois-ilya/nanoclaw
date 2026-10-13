import { useState } from 'preact/hooks';
import type { Connector, ConnectorCall, ConnectorsView, ConnectorTool } from '../api/types';
import { useApp, useApi, invalidate } from '../ctx';
import { CALL_DECISION, CONNECTOR_STATUS, callOutcome, groupTools, keyLine, policyForAsk } from '../connectors-util';
import { ago, dateShort } from '../format';
import * as tg from '../tg';
import { Btn, Chip, Hint, Loadable, Row, Screen, Section, Switch, useAction } from '../ui';

export function Connectors() {
  const { api, toast } = useApp();
  const res = useApi<ConnectorsView>('/api/connectors');
  const act = useAction(toast);

  /** Replace one connector in the cached list with the server's answer. */
  function put(c: Connector) {
    const d = res.data;
    if (d) res.set({ ...d, connectors: d.connectors.map((x) => (x.id === c.id ? c : x)) });
    invalidate(`/api/connectors/${c.id}/calls`);
  }
  async function add(catalogId: string) {
    let c: Connector | undefined;
    await act.run(async () => {
      c = await api.post<Connector>('/api/connectors', { catalogId });
    });
    const d = res.data;
    if (c && d) res.set({ ...d, connectors: [...d.connectors, c] });
  }

  return (
    <Screen title="Коннекторы" sub="Внешние сервисы для ассистента">
      <Loadable res={res} rows={3}>
        {(d) => {
          const have = new Set(d.connectors.map((c) => c.catalogId));
          const rest = d.catalog.filter((i) => !have.has(i.id));
          return (
            <>
              {d.connectors.length === 0 && (
                <Hint emoji="🔌">
                  Подключи сервис, и ассистент сможет работать с ним от твоего имени. Действия, которые что-то меняют,
                  он делает только после твоего подтверждения в Telegram.
                </Hint>
              )}
              {d.connectors.map((c) => (
                <ConnectorBlock
                  key={c.id}
                  c={c}
                  catalog={d.catalog.find((i) => i.id === c.catalogId)}
                  onChange={put}
                  onRemoved={() => {
                    res.set({ ...d, connectors: d.connectors.filter((x) => x.id !== c.id) });
                  }}
                />
              ))}
              {rest.length > 0 && (
                <Section
                  header="Каталог"
                  footer="Ключ сервиса хранится только на шлюзе и после сохранения нигде не показывается."
                >
                  {rest.map((i) => (
                    <Row
                      key={i.id}
                      icon={{ name: 'connections', color: 'purple' }}
                      title={i.title}
                      sub={i.description}
                      right={
                        <Btn kind="tint" onClick={() => add(i.id)} disabled={act.busy}>
                          Подключить
                        </Btn>
                      }
                    />
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

function ConnectorBlock({
  c,
  catalog,
  onChange,
  onRemoved,
}: {
  c: Connector;
  catalog?: ConnectorsView['catalog'][number];
  onChange(c: Connector): void;
  onRemoved(): void;
}) {
  const { api, me, toast } = useApp();
  const act = useAction(toast);
  const [key, setKey] = useState('');
  const [kind, label] = CONNECTOR_STATUS[c.status] ?? [undefined, c.status];
  const base = `/api/connectors/${encodeURIComponent(c.id)}`;
  const noKey = !c.key.set;

  async function patch(body: Record<string, unknown>, okMsg?: string) {
    const prev = c;
    // Optimistic for switches; the server's answer (or the rollback) is the final word.
    if ('enabled' in body) onChange({ ...c, enabled: body.enabled as boolean });
    if ('readOnly' in body) onChange({ ...c, readOnly: body.readOnly as boolean });
    let out: Connector | undefined;
    const ok = await act.run(async () => {
      out = await api.patch<Connector>(base, body);
    }, okMsg);
    onChange(ok && out ? out : prev);
  }
  async function saveKey() {
    const value = key.trim();
    if (!value) return;
    let out: Connector | undefined;
    const ok = await act.run(async () => {
      out = await api.put<Connector>(`${base}/key`, { value });
    }, 'Ключ сохранён');
    if (ok && out) {
      setKey('');
      onChange(out);
    }
  }
  async function removeKey() {
    const yes = await tg.confirm({
      title: 'Удалить ключ?',
      message: `${c.title} будет выключен, пока вы не введёте новый ключ.`,
      okText: 'Удалить',
      destructive: true,
    });
    if (!yes) return;
    let out: Connector | undefined;
    const ok = await act.run(async () => {
      out = await api.del<Connector>(`${base}/key`);
    }, 'Ключ удалён');
    if (ok && out) onChange(out);
  }
  async function remove() {
    const yes = await tg.confirm({
      title: `Отключить ${c.title}?`,
      message: 'Ключ и настройки инструментов будут удалены.',
      okText: 'Отключить',
      destructive: true,
    });
    if (!yes) return;
    const ok = await act.run(() => api.del(base), 'Коннектор удалён');
    if (ok) onRemoved();
  }
  async function setAsk(t: ConnectorTool, ask: boolean) {
    await patch({ toolPolicy: { [t.name]: policyForAsk(t, ask) } });
  }

  const groups = groupTools(c.tools);
  return (
    <>
      <Section
        header={c.title}
        footer={
          c.applying
            ? 'Применяется к активным разговорам — это занимает до минуты.'
            : c.enabled
              ? 'Изменения подхватят новые и простаивающие разговоры.'
              : undefined
        }
      >
        <Row
          icon={{ name: 'connections', color: 'purple' }}
          title="Состояние"
          sub={keyLine(c)}
          right={<Chip kind={kind}>{label}</Chip>}
        />
        {c.warning && (
          <div class="quote" style="padding-top:2px;color:var(--danger)">
            {c.warning}
          </div>
        )}
        <Row
          title="Включён"
          sub={noKey ? 'Сначала добавьте ключ' : undefined}
          right={
            <Switch
              checked={c.enabled}
              disabled={act.busy || (noKey && !c.enabled)}
              label={`${c.title}: включить`}
              onChange={(v) => patch({ enabled: v })}
            />
          }
        />
        <Row
          title="Только чтение"
          sub="Сервис не отдаёт инструменты, которые что-то меняют"
          right={
            <Switch
              checked={c.readOnly}
              disabled={act.busy}
              label={`${c.title}: только чтение`}
              onChange={(v) => patch({ readOnly: v })}
            />
          }
        />
      </Section>

      <Section
        header="Мой ключ"
        footer={
          <>
            {catalog?.keyHelp} Ключ только записывается: после сохранения его нигде не видно.
            {catalog?.keyUrl && (
              <>
                {' '}
                <a
                  href={catalog.keyUrl}
                  onClick={(e) => {
                    e.preventDefault();
                    tg.openLink(catalog.keyUrl);
                  }}
                >
                  Создать ключ
                </a>
              </>
            )}
          </>
        }
      >
        {c.key.set && c.key.savedAt && <Row title="Сохранён" value={dateShort(c.key.savedAt, me.tz)} />}
        <input
          class="field"
          style={c.key.set && c.key.savedAt ? 'border-top:0.5px solid var(--sep)' : undefined}
          type="password"
          autocomplete="off"
          autocapitalize="off"
          spellcheck={false}
          placeholder={c.key.set ? 'Заменить ключ' : (catalog?.keyLabel ?? 'Вставить ключ')}
          value={key}
          onInput={(e) => setKey((e.target as HTMLInputElement).value)}
          aria-label={`Ключ ${c.title}`}
        />
        <div class="btns" style="padding:8px 16px">
          <Btn kind="tint" onClick={saveKey} disabled={act.busy || key.trim().length === 0}>
            Сохранить
          </Btn>
          {c.key.set && (
            <Btn kind="danger" onClick={removeKey} disabled={act.busy}>
              Удалить
            </Btn>
          )}
        </div>
      </Section>

      {c.tools.length === 0 ? (
        <Section header="Инструменты" footer="Список появится после проверки ключа.">
          <Row title={<span class="muted">Пока пусто</span>} />
        </Section>
      ) : (
        <>
          <ToolGroup
            header="Спрашивать"
            footer="Перед вызовом придёт карточка в личку. Неизвестные и меняющие данные инструменты — здесь."
            tools={groups.ask}
            busy={act.busy}
            onAsk={setAsk}
            onReset={(t) => patch({ toolPolicy: { [t.name]: null } })}
            title={c.title}
          />
          <ToolGroup
            header="Без подтверждения"
            footer="Только чтение: выполняются сразу."
            tools={groups.auto}
            busy={act.busy}
            onAsk={setAsk}
            onReset={(t) => patch({ toolPolicy: { [t.name]: null } })}
            title={c.title}
          />
        </>
      )}

      <Calls id={c.id} base={base} tz={me.tz} />

      <Section>
        <Row danger center title={`Отключить ${c.title}`} onClick={remove} disabled={act.busy} />
      </Section>
    </>
  );
}

function ToolGroup({
  header,
  footer,
  tools,
  busy,
  onAsk,
  onReset,
  title,
}: {
  header: string;
  footer: string;
  tools: ConnectorTool[];
  busy: boolean;
  title: string;
  onAsk(t: ConnectorTool, ask: boolean): void;
  onReset(t: ConnectorTool): void;
}) {
  if (tools.length === 0) return null;
  return (
    <Section header={`${header} · ${tools.length}`} footer={footer}>
      {tools.map((t) => (
        <Row
          key={t.name}
          title={t.title || t.name}
          sub={
            <>
              {t.title ? `${t.name} · ` : ''}
              {t.policy ? 'вручную' : t.readOnly ? 'чтение' : 'меняет данные'}
              {t.policy && (
                <>
                  {' '}
                  ·{' '}
                  <button class="act" onClick={() => onReset(t)} disabled={busy}>
                    по умолчанию
                  </button>
                </>
              )}
            </>
          }
          right={
            <Switch
              checked={t.asks}
              disabled={busy}
              label={`${title}: спрашивать для ${t.name}`}
              onChange={(v) => onAsk(t, v)}
            />
          }
        />
      ))}
    </Section>
  );
}

function Calls({ id, base, tz }: { id: string; base: string; tz: string }) {
  const res = useApi<ConnectorCall[]>(`${base}/calls`);
  return (
    <Section
      header="Последние вызовы"
      footer="Журнал хранит только имя инструмента и исход, без аргументов и результатов."
    >
      {res.error && (
        <Row
          title={<span class="muted">Не удалось загрузить</span>}
          right={
            <Btn kind="gray" onClick={res.reload}>
              Повторить
            </Btn>
          }
        />
      )}
      {!res.error && res.data === undefined && <Row title={<span class="muted">Загружаю…</span>} />}
      {res.data && res.data.length === 0 && <Row title={<span class="muted">Вызовов пока не было</span>} />}
      {res.data?.map((c, i) => {
        const [kind, label] = CALL_DECISION[c.decision] ?? [undefined, c.decision];
        const outcome = callOutcome(c);
        return (
          <Row
            key={`${id}:${c.at}:${i}`}
            title={c.tool}
            sub={[
              ago(c.at, new Date(), tz),
              outcome,
              c.durationMs != null ? `${(c.durationMs / 1000).toFixed(1)} с` : null,
            ]
              .filter(Boolean)
              .join(' · ')}
            right={
              <Chip kind={c.status === 'tool_error' || c.status === 'upstream_error' ? 'bad' : kind}>{label}</Chip>
            }
          />
        );
      })}
    </Section>
  );
}
