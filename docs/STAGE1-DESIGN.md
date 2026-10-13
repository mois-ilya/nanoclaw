# Этап 1 — коннекторы через nanogate: проект реализации

Статус: проект для реализации, 2026-10-14. Основание: `docs/CONTROL-PLANE-PLAN.md` (этап 0 закрыт), разбор кода (nanogate, хост,
agent-runner, Кабинет), внешние источники (GitHub MCP, MCP Streamable HTTP, Claude Code MCP) и независимый проект Codex.
Все пути даны от корня репозитория `nanoclaw-v2`. Деплой один, в конце. Доступ к продакшену для этой работы не нужен.

---

## 1. Решения и что сознательно НЕ делаем

### 1.1 Ключевые решения

1. **Источник правды о коннекторах — хост** (`nc_mcp_connectors`). nanogate получает копию через admin API и держит её в
   `mcp_connectors`. Хост досылает всё при старте и раз в 5 минут (`syncAllConnectors`). Схема та же, что у тенантов: `pushTenant`/`provisionFromStore`.
2. **Ключи хранятся только в nanogate** (`secrets`, имя `mcp.<connectorId>`). Хост пишет их через уже существующий `PUT /secrets`
   и обратно не читает. Расшифровывает их только `/mcp/<id>` (новая `getSecret`).
3. **Отдельный листенер nanogate `mcpPort = 8081`** (модуль `mcp-proxy.ts`), без смешивания с anthropic-листенером.
   nanorelay получает третью строку маршрута `8081=nanogate:8081`; Go-код не меняется.
4. **Валидацию URL на хосте не ослабляем.** Записи коннекторов не попадают в `mcp_servers`. Их добавляет хук
   `setManagedMcpServersProvider` в `materializeContainerJson` уже после `sanitizeStoredMcpServers`. `add_mcp_server` по-прежнему
   не примет `http://nanorelay:…`. Прокси CONNECT этот адрес не видит: `nanorelay` уже есть в `NO_PROXY`.
5. **Сессионный токен в заголовок подставляет agent-runner.** Если URL начинается с `NC_MCP_GATEWAY_PREFIX`, runner добавляет
   `Authorization: Bearer $ANTHROPIC_API_KEY`. Сам `container.json` общий для всех сессий агента и токенов не содержит.
6. **Подтверждение идёт через готовый `gateway-approval-coordinator`.** Вместо заглушки `nanogateProvider.approvals.subscribe`
   появляется long-poll на `GET /mcp-approvals`. Решение отправляется через `POST /mcp-approvals/:id/decision`. Режим не durable:
   вызов живёт столько же, сколько исходный HTTP-запрос. nanogate держит `tools/call` до 300 с.
7. **Классификация инструментов.** Инструмент опасный, если `readOnlyHint !== true` в последнем `tools/list` от апстрима.
   Владелец может переопределить это для отдельного инструмента (`ask`/`auto`). Неизвестный инструмент считается опасным.
8. **Применение ко всем сессиям агента.** При изменении хост ставит отметку `cfg-changed:<group>` (kv, время в мс). Сборщик
   останавливает каждый работающий контейнер, который запущен раньше отметки и сейчас простаивает (нет claim, нет due-сообщений).
   Будить контейнер не нужно: следующий запуск сам перечитает `container.json`. Сборщик опирается на время старта контейнера,
   поэтому пережидает перезапуск хоста без отдельного счётчика поколений.
9. **В Stage 1 коннекторы видит в Кабинете только владелец.** Маршруты помечены `owner: true`. Бэкенд при этом по-тенантный:
   друзьям коннекторы включаются снятием флага и передачей `approverUserId`, это сделаем позже.
10. **Свой ключ Groq хранится файлом на хосте** (`<DATA_DIR>/secrets/groq/<user_id>`), а не в nanogate. Ключ нужен самому хосту
    для STT. Если класть его в nanogate, пришлось бы открыть чтение секретов через admin API, а сейчас эти секреты только на запись.

### 1.2 Сознательно НЕ делаем

- Единый реестр возможностей, 4 уровня областей, асинхронный claim/resume, taint, сборка самописных MCP, stdio-коннекторы, OAuth
  (это этап 2).
- Durable-подтверждения. Если хост или nanogate перезапустился, ожидающий вызов отклоняется. Повторно его никто не выполняет.
- Пакетные JSON-RPC (массивы) в `/mcp`: отвечаем 400. Standalone SSE (`GET /mcp/<id>`): отвечаем 405. Спека это допускает.
- Хранение аргументов и результатов вызовов. Журнал пишет только метаданные.
- Автоповтор изменяющих вызовов при сетевой ошибке.
- Подтверждения для Bash/WebFetch и прочих встроенных инструментов.
- Миграцию ключей при смене `gateIdOf` (рост epoch). Ключ после этого придётся ввести заново, Кабинет покажет «ключ не задан».

---

## 2. Компоненты и изменения по файлам

### 2.1 nanogate (`nanogate/src`)

| Файл                       | Изменение                                                                                                                                                                                                                                                                                                                                              |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `config.ts`                | `listen.mcpPort` (по умолчанию 8081), env `NANOGATE_MCP_PORT`; блок `mcp` с `holdMs=300000`, `upstreamTimeoutMs=60000`, `maxPendingPerTenant=4`, `maxPendingTotal=16`, `maxBodyBytes=1048576`, `maxListBytes=8388608`, `socketIdleMs=600000`, `callsRetentionDays=30` (все поля опциональны, валидатор как у остальных)                                |
| `db.ts`                    | таблицы `mcp_connectors`, `mcp_tools`, `mcp_calls` (§3.1); функции `getMcpConnector`, `upsertMcpConnector`, `deleteMcpConnector`, `listMcpConnectors(tenantId?)`, `upsertMcpTools(connectorId, tools, replaceAll)`, `listMcpTools(connectorId)`, `insertMcpCall`, `finishMcpCall`, `listMcpCalls(tenantId, connectorId?, limit)`, `pruneMcpCalls(now)` |
| `tokens.ts`                | `getSecret(db, encKey, tenantId, name): string \| null` (`decrypt` поверх `secrets`)                                                                                                                                                                                                                                                                   |
| `mcp-proxy.ts` (новый)     | `createMcpServer(ctx)`: маршрутизация `/mcp/:id`, аутентификация, привязка MCP-сессий, классификация, удержание, проброс, журнал. Плюс `probeConnector(ctx, id)`                                                                                                                                                                                       |
| `mcp-approvals.ts` (новый) | реестр ожидающих вызовов: `hold(...)`, `decide(id, decision)`, `waitPending(since, waitMs)`, `rejectForConnector(id, reason)`, счётчик `version`                                                                                                                                                                                                       |
| `mcp-upstream.ts` (новый)  | `upstreamRequest(ctx, url, init)`: только HTTPS, резолв через `ctx.resolve` с проверкой `denySet` и закреплением IP (lookup-хук), редиректы не выполняются (3xx → ошибка), таймаут ответа = `upstreamTimeoutMs`. Публичную проверку адресов взять из `connect-proxy.ts` и вынести в экспорт `checkPublicAddresses(ctx, host)`                          |
| `context.ts`               | поля `mcpSessions: Map<string, McpSessionBinding>`, `mcpApprovals: McpApprovals`                                                                                                                                                                                                                                                                       |
| `server.ts`                | 5-й листенер `mcp` на `listen.mcpPort`/`listen.bind`: `requestTimeout=0`, `headersTimeout=30000`, `timeout=mcp.socketIdleMs`, `maxConnections=256`; в существующий 60-секундный таймер добавить `pruneMcpCalls`                                                                                                                                        |
| `admin-api.ts`             | маршруты `/mcp-connectors*`, `/mcp-calls`, `/mcp-approvals*` (§3.2). При `DELETE /secrets/:tenant/:name` с именем `mcp.*` сбрасываются привязки MCP-сессий этого коннектора                                                                                                                                                                            |
| `live.ts`                  | без изменений. Удерживаемые и проксируемые вызовы регистрируются как `kind:'request'`, тогда `killToken`/`killTenant` их рвут                                                                                                                                                                                                                          |

Существующую таблицу `connectors` и маршруты `/connectors` (SOCKS домашнего выхода) **не трогаем**.

### 2.2 nanorelay

Код не меняется. `NANORELAY_MAP` дополняется в `src/gateway-providers/nanogate/index.ts:169`:
`'8080=nanogate:8080,3128=nanogate:3128,8081=nanogate:8081'`. Удерживаемые соединения идут в общий лимит 256 соединений;
лимит ожиданий 4 на тенанта держит их число низким.

### 2.3 Nix

- `nix/module.nix:193`: в `listen` добавить `mcpPort = 8081;`. Порт не публикуется (`-p` не нужен): relay ходит к nanogate
  по сети `nanogate-svc`.
- `nix/nanogate-image.nix:22`: добавить `"8081/tcp" = { };` в `ExposedPorts`.
- Новых опций модуля нет. `toolSearch` уже есть.

### 2.4 Хост — шлюзовый слой (`src/gateway-providers/nanogate`, `src/container-config.ts`)

| Файл                      | Изменение                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `admin-client.ts`         | методы из §3.2 (`putMcpConnector`, `deleteMcpConnector`, `listMcpConnectors`, `probeMcpConnector`, `mcpCalls`, `waitMcpApprovals`, `decideMcpApproval`). У `request` появляется опциональный `timeoutMs` для long-poll (`waitMs + 5000`) и `signal`                                                                                                                                                                                                                                                                              |
| `index.ts`                | relay map (§2.2). `agentEnv` добавляет `NC_MCP_GATEWAY_PREFIX=http://nanorelay:8081/mcp/` и `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT=420000`, а `CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS=0` — только если переменная встречается в бандле CLI (`grep` по `container/agent-runner/node_modules/@anthropic-ai/claude-agent-sdk`; если её нет, не ставить). `approvals.subscribe` — реализация из §4.2. Экспорт `MCP_GATEWAY_PORT = 8081`                                                                                                      |
| `src/container-config.ts` | `McpHttpServerConfig` получает поле `timeout?: number`; `parseMcpServerConfig` пропускает `timeout` (целое 1000..3600000). Новые хуки: `setManagedMcpServersProvider(fn)`, где `fn(agentGroupId) => Promise<Record<string, McpHttpServerConfig>>`, и `setConfigChangedListener(fn)` + `notifyConfigChanged(agentGroupId, reason)`. В `materializeContainerJson` после `configFromDb` управляемые серверы вливаются в `config.mcpServers`: при совпадении имени управляемый сервер перекрывает сохранённый и в лог пишется `warn` |

### 2.5 Хост — наш слой (`src/nc`)

| Файл                                | Изменение                                                                                                                                                                                                                                                                                                                                                              |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `migrations.ts`                     | `version: 3, name: 'module:nc:mcp-connectors'` → `nc_mcp_connectors` (§3.1)                                                                                                                                                                                                                                                                                            |
| `mcp-catalog.ts` (новый)            | `CATALOG: CatalogEntry[]`, пока только GitHub (§6.1)                                                                                                                                                                                                                                                                                                                   |
| `mcp-connectors.ts` (новый)         | доступ к таблице (`listConnectors(userId)`, `getConnector(id)`, `createConnector`, `patchConnector`, `deleteConnector`), `pushConnector(row)` и `syncAllConnectors()` (вызов при старте и раз в 5 минут, ошибки идут в лог), `managedServersFor(agentGroupId)` (провайдер для хука), `saveConnectorKey(tenant, id, value)`, `deleteConnectorKey`, `connectorView(...)` |
| `config-apply.ts` (новый)           | `markGroupConfigDirty(agentGroupId, reason)` через `kvSet('cfg-changed:'+group, String(Date.now()))`; `applyConfigSweep()` раз в 30 с и сразу после отметки (с debounce 2 с); `groupApplying(agentGroupId): Promise<boolean>`. Регистрируется через `setConfigChangedListener`                                                                                         |
| `commands.ts`                       | экспортировать `hasProcessingClaim` (сейчас он внутренний)                                                                                                                                                                                                                                                                                                             |
| `index.ts` / `platform.ts`          | регистрация `setManagedMcpServersProvider(managedServersFor)`, `setConfigChangedListener(markGroupConfigDirty)`, таймеры sync/sweep                                                                                                                                                                                                                                    |
| `groq-key.ts`, `stt.ts`             | свой ключ пользователя (§6.2)                                                                                                                                                                                                                                                                                                                                          |
| `miniapp/connectors-api.ts` (новый) | обработчики `/api/connectors*` (§3.3). Монолит `api.ts` не раздуваем, импортируем массив маршрутов                                                                                                                                                                                                                                                                     |
| `miniapp/api.ts`                    | вливание маршрутов коннекторов; навыки: новый GET и `PUT /api/skills/:id` (§7); Groq: `PUT/DELETE /api/secrets/groq-key` для всех и `stt` в `connections` для всех                                                                                                                                                                                                     |
| `miniapp/types.ts`                  | типы из §3.3 (байт-в-байт совпадают с `miniapp/src/api/types.ts`)                                                                                                                                                                                                                                                                                                      |
| `src/modules/self-mod/apply.ts`     | после `updateContainerConfigJson` добавить `notifyConfigChanged(agentGroupId, 'mcp server added')`. Перезапуск сессии-инициатора сохраняется, остальные сессии подхватывает сборщик (закрывает проблему №10 плана)                                                                                                                                                     |

### 2.6 agent-runner (`container/agent-runner/src`)

- `providers/types.ts`: в http-вариант `McpServerConfig` добавить `timeout?: number`.
- `index.ts` (цикл по `config.mcpServers`): для `type==='http'` и `url.startsWith(process.env.NC_MCP_GATEWAY_PREFIX)` при
  непустом `ANTHROPIC_API_KEY` выставить `headers = { ...headers, Authorization: 'Bearer ' + key }`. В лог писать имя сервера, без
  заголовков. `alwaysLoad` не ставить: инструменты остаются за tool search.
- `providers/claude.ts`: ничего не меняется. `strictMcpConfig` и `allowedTools mcp__<name>__*` уже работают. Проверено: если вызов
  удерживается 5 минут, его не убивают ни `kill-claim` (heartbeat обновился после claim на событии tool_use), ни
  `kill-ceiling` (30 минут). Нужен только тест (§8).

### 2.7 Кабинет (`miniapp/src`)

- `screens/Connectors.tsx` (новый), `router.ts` (`connectors` в `RouteName`, `SIMPLE`, `OWNER_ONLY`), `App.tsx` (case),
  `screens/Home.tsx` (пункт в блоке владельца).
- `screens/Skills.tsx`: вместо Chip — `Switch`, блокировка через `locked`; подпись «Применится к новым и простаивающим разговорам».
- `screens/Connections.tsx`: блок Groq показываем всем. Пользователь видит поле «Мой ключ», владелец дополнительно видит
  блок «общий ключ», который уже существует.
- `api/types.ts` (копия), `api/mock.ts` (моки для новых маршрутов).

---

## 3. Контракты

### 3.1 Схемы таблиц

nanogate (`db.ts`, `CREATE TABLE IF NOT EXISTS` в общем init):

```sql
CREATE TABLE IF NOT EXISTS mcp_connectors (
  id            TEXT PRIMARY KEY,          -- ^[a-z0-9-]{3,64}$, напр. 'github-3f9a1c2e'
  tenant_id     TEXT NOT NULL,
  title         TEXT NOT NULL,             -- 'GitHub' (для карточки)
  url           TEXT NOT NULL,             -- https only, фиксирован хостом
  secret_name   TEXT NOT NULL,             -- 'mcp.<id>'
  extra_headers TEXT NOT NULL DEFAULT '{}',-- несекретные заголовки, напр. {"X-MCP-Readonly":"true"}
  tool_policy   TEXT NOT NULL DEFAULT '{}',-- {"<tool>":"ask"|"auto"}
  enabled       INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS mcp_connectors_tenant ON mcp_connectors(tenant_id);
CREATE TABLE IF NOT EXISTS mcp_tools (
  connector_id TEXT NOT NULL,
  name         TEXT NOT NULL,
  read_only    INTEGER NOT NULL,           -- 1 только если annotations.readOnlyHint === true
  title        TEXT,                       -- annotations.title ?? title, ≤120 симв.
  seen_at      INTEGER NOT NULL,
  PRIMARY KEY (connector_id, name)
);
CREATE TABLE IF NOT EXISTS mcp_calls (
  id           TEXT PRIMARY KEY,           -- 'mc_' + 12 байт hex; для опасных совпадает с id ожидания
  tenant_id    TEXT NOT NULL,
  connector_id TEXT NOT NULL,
  session_key  TEXT NOT NULL,
  tool         TEXT NOT NULL,
  dangerous    INTEGER NOT NULL,
  decision     TEXT NOT NULL,              -- auto|approved|denied|expired|unavailable|disconnected|revoked|disabled|pending
  status       TEXT,                       -- ok|tool_error|upstream_error|unknown|null(не выполнялся)
  http_status  INTEGER,
  started_at   INTEGER NOT NULL,
  finished_at  INTEGER
);
CREATE INDEX IF NOT EXISTS mcp_calls_tenant_time ON mcp_calls(tenant_id, started_at);
```

Хост (`src/nc/migrations.ts`, v3):

```sql
CREATE TABLE IF NOT EXISTS nc_mcp_connectors (
  id            TEXT PRIMARY KEY,           -- '<catalogId>-' + 4 байта hex
  user_id       TEXT NOT NULL,              -- nc_tenants.user_id (gate id вычисляется gateIdOf при каждом push)
  catalog_id    TEXT NOT NULL,              -- 'github'
  url           TEXT NOT NULL,
  secret_name   TEXT NOT NULL,              -- 'mcp.<id>'
  read_only     INTEGER NOT NULL DEFAULT 0,
  tool_policy   TEXT NOT NULL DEFAULT '{}',
  enabled       INTEGER NOT NULL DEFAULT 0,
  key_saved_at  TEXT,                       -- null = ключа нет (значение никогда не хранится на хосте)
  key_status    TEXT,                       -- null|ok|rejected|unverified
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE (user_id, catalog_id)
);
```

Удаление тенанта (`src/nc/lifecycle.ts`, где уже стираются секреты) дополнительно удаляет строки `nc_mcp_connectors` и
вызывает `deleteMcpConnector` для каждой.

### 3.2 Admin API nanogate (Unix-сокет)

Ошибки возвращаются в формате `{error:'<code>'}` с подходящим статусом. Идентификаторы проверяются регэкспом `ID`.

| Метод и путь                                   | Тело                                                                                                                                  | Ответ                                                                                                                                                                                                                                            |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `PUT /mcp-connectors/:id`                      | `{tenantId, title, url, secretName, extraHeaders: Record<string,string>, toolPolicy: Record<string,'ask'\|'auto'>, enabled: boolean}` | `204`. Проверки: тенант существует, `url` начинается с `https://`, ключи `extraHeaders` подходят под `^X-MCP-[A-Za-z-]+$`. Если сменились `tenantId`, `url` или `enabled→false`: `rejectForConnector(id,'disabled')` и сброс привязок MCP-сессий |
| `DELETE /mcp-connectors/:id`                   | —                                                                                                                                     | `204`. Удаляет коннектор и `mcp_tools`, вызывает `rejectForConnector`. Секрет хост удаляет сам                                                                                                                                                   |
| `GET /mcp-connectors?tenantId=`                | —                                                                                                                                     | `{connectors:[{id, tenantId, enabled, tools:[{name, readOnly, title}], toolsSeenAt: number\|null}]}`                                                                                                                                             |
| `POST /mcp-connectors/:id/probe`               | —                                                                                                                                     | `200 {ok:true, tools:number}` или `200 {ok:false, error:'no_key'\|'key_rejected'\|'upstream_unreachable'\|'upstream_error', status?:number}`                                                                                                     |
| `GET /mcp-calls?tenantId=&connectorId=&limit=` | —                                                                                                                                     | `{calls:[{id, connectorId, tool, dangerous, decision, status, startedAt, finishedAt}]}`, `limit ≤ 100` (по умолчанию 20), сначала новые                                                                                                          |
| `GET /mcp-approvals?since=<n>&waitMs=<ms>`     | —                                                                                                                                     | long-poll. Отвечает сразу, если `version > since`, иначе через `waitMs` (≤ 30000). `{version:number, pending:[McpPending]}`                                                                                                                      |
| `POST /mcp-approvals/:id/decision`             | `{decision:'approve'\|'deny'\|'unavailable'}`                                                                                         | `{accepted:boolean}`. `false` — вызов уже завершён                                                                                                                                                                                               |

```ts
interface McpPending {
  id: string; // 'mc_…'
  tenantId: string;
  sessionKey: string; // runtime identity 'slug/group/session'
  connectorId: string;
  connectorTitle: string;
  tool: string;
  args: Array<{ label: string; type: 'text' | 'long_text'; value: string }>; // готовые displayFields, ≤12 полей
  createdAt: string; // ISO
  expiresAt: string; // createdAt + holdMs
}
```

`args` собирает nanogate. Каждый ключ верхнего уровня `params.arguments` превращается в отдельное поле, значение — строка или JSON.
Длинные значения nanogate обрезает сам с явной пометкой `… (+N симв.)`: до 200 символов для `text` и до 1200 для `long_text`
(`long_text`, если значение длиннее 80). Полей больше 12 → последнее поле `{label:'…', value:'ещё N полей'}`. Ключи `token`,
`password`, `secret` (регэксп как `SECRET_QUERY_KEY_RE`) маскируются как `•••`. Значения перед отправкой проходят через валидатор
`gatewayApprovalPresentation`, поэтому лимиты обрезки нужно сверить с ним в тесте.

Методы клиента (`admin-client.ts`):
`putMcpConnector(id, body)`, `deleteMcpConnector(id)`, `listMcpConnectors(tenantId)`, `probeMcpConnector(id)`,
`mcpCalls({tenantId, connectorId?, limit?})`, `waitMcpApprovals(since, waitMs, signal)`, `decideMcpApproval(id, decision)`.
Секреты используют существующие `putSecret` / `deleteSecret` / `listSecrets`.

### 3.3 API Кабинета

Все маршруты берут тенанта только из сессии. Маршруты коннекторов в Stage 1 помечены `owner: true`.

| Метод и путь                     | Тело                                                                     | Ответ                                                                                           |
| -------------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `GET /api/connectors`            | —                                                                        | `ConnectorsView`                                                                                |
| `POST /api/connectors`           | `{catalogId}`                                                            | `Connector` (создаётся выключенным, без ключа). Повтор того же `catalogId` → `409`              |
| `PATCH /api/connectors/:id`      | `{enabled?, readOnly?, toolPolicy?: Record<string,'ask'\|'auto'\|null>}` | `Connector`. `null` удаляет переопределение. Включить без ключа → `409 'Сначала добавьте ключ'` |
| `PUT /api/connectors/:id/key`    | `{value}`                                                                | `Connector`. Ключ не принят → `400 'GitHub не принял ключ'`                                     |
| `DELETE /api/connectors/:id/key` | —                                                                        | `Connector` (коннектор выключается)                                                             |
| `DELETE /api/connectors/:id`     | —                                                                        | `204`                                                                                           |
| `GET /api/connectors/:id/calls`  | —                                                                        | `ConnectorCall[]` (20 последних)                                                                |
| `GET /api/skills`                | —                                                                        | `Skill[]` (все доступные, включая выключенные)                                                  |
| `PUT /api/skills/:id`            | `{enabled}`                                                              | `Skill[]`. Скилл с `locked` → `403`                                                             |
| `PUT /api/secrets/groq-key`      | `{value}`                                                                | `SttView`. Проверка как у владельца: `GROQ_KEY_RE` и тестовый `/models`                         |
| `DELETE /api/secrets/groq-key`   | —                                                                        | `SttView`                                                                                       |

```ts
export interface CatalogItem {
  id: string;
  title: string;
  description: string;
  keyLabel: string;
  keyHelp: string;
  keyUrl: string;
}
export interface ConnectorTool {
  name: string;
  title?: string;
  readOnly: boolean;
  policy: 'ask' | 'auto' | null;
  asks: boolean;
}
export interface Connector {
  id: string;
  catalogId: string;
  title: string;
  enabled: boolean;
  readOnly: boolean;
  key: { set: boolean; savedAt?: string; status: 'ok' | 'rejected' | 'unverified' | null };
  status: 'ok' | 'no_key' | 'key_rejected' | 'sync_error';
  applying: boolean; // есть работающие сессии со старым конфигом
  tools: ConnectorTool[]; // пусто, пока не было probe/tools/list
}
export interface ConnectorsView {
  catalog: CatalogItem[];
  connectors: Connector[];
}
export interface ConnectorCall {
  at: string;
  tool: string;
  dangerous: boolean;
  decision:
    | 'auto'
    | 'approved'
    | 'denied'
    | 'expired'
    | 'unavailable'
    | 'disconnected'
    | 'revoked'
    | 'disabled'
    | 'pending';
  status: 'ok' | 'tool_error' | 'upstream_error' | 'unknown' | null;
  durationMs?: number;
}
// Skill без изменений: {id, name, description, enabled, locked}
// SttView.groqKey.source: 'own' | 'miniapp' | 'server' | null  (добавлено 'own')
```

`asks` = итоговая классификация из §5 (`policy ?? !readOnly`).

### 3.4 Запись в container.json

Имя сервера — `serverName` из каталога (`github`). Поэтому инструменты называются `mcp__github__<tool>`.

```json
"github": { "type": "http", "url": "http://nanorelay:8081/mcp/github-3f9a1c2e", "timeout": 420000 }
```

Сервер попадает в файл, только если `enabled=1` и `key_saved_at IS NOT NULL`. Полей `headers`, `instructions` и `alwaysLoad`
в записи нет. Заголовок `Authorization` добавляет runner в памяти.

### 3.5 Env

| Где                | Переменная                           | Значение                                                   |
| ------------------ | ------------------------------------ | ---------------------------------------------------------- |
| агент (`agentEnv`) | `NC_MCP_GATEWAY_PREFIX`              | `http://nanorelay:8081/mcp/`                               |
| агент              | `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT`  | `420000`                                                   |
| агент              | `CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS` | `0` (только если переменная есть в бандле CLI)             |
| relay              | `NANORELAY_MAP`                      | `8080=nanogate:8080,3128=nanogate:3128,8081=nanogate:8081` |
| nanogate           | `NANOGATE_MCP_PORT`                  | необязательно, переопределяет `listen.mcpPort`             |

`MCP_TOOL_TIMEOUT` **не** ставим: он глобальный и задел бы встроенный сервер `nanoclaw`.

---

## 4. Последовательности

### 4.1 Обычный (безопасный) вызов

1. Агент делает `POST http://nanorelay:8081/mcp/<id>` с `Authorization: Bearer ngs_…`, `Mcp-Session-Id` и
   `MCP-Protocol-Version`. relay передаёт TCP в `nanogate:8081`.
2. `mcp-proxy`:
   а) Путь должен совпадать с `^/mcp/([a-z0-9-]{3,64})$`. `/.well-known/*` и всё прочее → 404 JSON.
   б) Токен проходит `authenticate(db, raw, 'session')`. Ошибка → `401 {error:'unauthorized'}` **без** `WWW-Authenticate`, чтобы
   клиент не начинал OAuth-discovery. Тенант на паузе → 403.
   в) Коннектор должен существовать, принадлежать `auth.tenant.id` и быть включён. Иначе 404: чужой коннектор не отличить от
   несуществующего.
   г) Для каждого метода, кроме `initialize`, проверяется `Mcp-Session-Id`: привязка `ctx.mcpSessions.get(sid)` должна совпадать
   по `tokenHash` и `connectorId`. Нет привязки → `404`, и клиент сам переинициализируется (так же это работает после рестарта nanogate).
   д) Тело ≤ `maxBodyBytes` разбирается как JSON. Массив → 400. Для `tools/call` выполняется классификация (§5). Вызов безопасный →
   `insertMcpCall(decision='auto')`.
   е) Ключ берётся из `getSecret(tenant, secret_name)`. Ключа нет → для `tools/call` ответ `isError` «ключ не задан», для прочих
   методов `503`.
3. Проброс через `upstreamRequest` на `connector.url`. В апстрим уходят только заголовки `content-type`, `accept`, `mcp-session-id`,
   `mcp-protocol-version`, `last-event-id` и все `mcp-*`, плюс `extra_headers` коннектора, `Authorization: Bearer <ключ>` и
   `user-agent: nanogate`. Заголовки агента (`authorization`, `cookie`, `x-forwarded-*`) отбрасываются.
4. Ответ агенту несёт только статус и заголовки `content-type`, `mcp-session-id`, `mcp-protocol-version`, `cache-control`.
   `www-authenticate` и `set-cookie` выкидываются. Тело стримится без буферизации, с flush на каждый чанк. Исключение — ответ на
   `tools/list`: его копия (≤ `maxListBytes`, JSON или SSE) разбирается и пишется в `upsertMcpTools(replaceAll=false)`.
5. Если ответ на `initialize` содержит `mcp-session-id`, создаётся привязка `{tokenHash, connectorId, lastUsed}`: TTL 24 ч простоя,
   не больше 2048 записей, при переполнении вытесняется самая старая. На `DELETE` с sid запрос уходит в апстрим, привязка удаляется.
6. Журнал: `finishMcpCall(status, http_status)` и строка в stdout
   `{msg:'mcp_call', tenant, connector, tool, decision, status, ms}`. Аргументов и ответов в журнале нет.
7. Если апстрим ответил 401/403 на `tools/call`, агент получает `isError` «GitHub не принял ключ — обновите его в Кабинете».
   Тело апстрима не пересылается, и коннектору ставится флаг для хоста (событие `insertEvent(tenant,'mcp_key_rejected',{connectorId})`).
   Хост в `pollBudgetEventsOnce` по этому событию выставляет `key_status='rejected'`. Нужен `if` по `type` до `handleBudgetEvent`.

### 4.2 Опасный вызов с карточкой

**Кто держит:** nanogate, на открытом HTTP-запросе агента. Состояние живёт в памяти `mcp-approvals.ts`.

1. Шаги 4.1 (а–е) проходят так же, только классификация выдаёт «опасный». Если превышен `maxPendingPerTenant` или `maxPendingTotal`,
   агент сразу получает `isError` «Слишком много вызовов ждут подтверждения». Иначе `hold()` создаёт запись `{id:'mc_…', …, expiresAt}`
   и `insertMcpCall(decision='pending')`, регистрирует `live` entry `kind:'request'` (её `destroy` → решение `revoked`) и
   увеличивает `version`, что будит long-poll.
2. **Хост** (`nanogateProvider.approvals.subscribe`), цикл до `signal.aborted`:
   ```
   since = 0; known = Map<id, true>; bootAt = Date.now()
   loop:
     try r = await admin.waitMcpApprovals(since, 25000, signal)
     catch → since = 0; await sleep(2000, signal); continue      // НЕ выходить: выход закрывает приём сессий
     since = r.version
     для id из known, которого нет в r.pending → known.delete(id); resolved?.(id)   // карточка «истекла/снята»
     для p из r.pending, которого нет в known → known.set(p.id);
        if Date.parse(p.createdAt) < bootAt - 5000 → decideMcpApproval(p.id,'unavailable')   // висел до рестарта хоста
        else decide(toRequest(p)).then(d => admin.decideMcpApproval(p.id, d)).catch(log.warn)
   ```
   `toRequest(p)` = `{id:p.id, trigger:'policy', agentGroupId, sessionId, runtimeIdentity:p.sessionKey, createdAt, expiresAt,
title:'<connectorTitle>: подтвердите действие', question:'Агент хочет вызвать <tool>', summary:{agent, action:p.tool,
resource:p.connectorTitle, reason:'инструмент может изменить данные'}, displayFields:p.args, audit:{connectorId, tool}}`.
   `agentGroupId` и `sessionId` получаются разбором `sessionKey`. Обратная функция к `gatewayRuntimeIdentity` —
   `parseRuntimeIdentity` в `index.ts`. Если не разобралось → `unavailable`.
3. Координатор выбирает одобряющего (`pickApprover` → владелец), пишет `pending_approvals` с `expires_at` и шлёт карточку `ask_question`
   с кнопками в личку владельца. Нажатие обрабатывает `handleGatewayApprovalResponse` (с проверкой нажавшего), он же правит карточку.
   `decide` возвращает `'approve' | 'deny'` (не durable: при сбое/истечении — `'deny'`).
4. Хост отправляет `POST /mcp-approvals/:id/decision`. nanogate:
   - `approve`: `revalidate()` токена, коннектор всё ещё включён и принадлежит тенанту, ключ на месте. Затем однократный проброс (шаги
     4.1.3–6), `decision='approved'`. Если проверка не прошла → `isError` с причиной, `decision='revoked'`/`'disabled'`.
   - `deny` → `isError`, `decision='denied'`; `unavailable` → `decision='unavailable'`.
5. Таймер `holdMs` (300 с) срабатывает раньше решения → `isError`, `decision='expired'`, запись убирается из `pending`. На следующем
   long-poll хост видит, что id пропал, и вызывает `resolved(id)`, карточка помечается истёкшей. Координатор сам отсчитывает
   `expiresAt - 1 s` и тоже истекает. Если решение хоста приходит после таймера, ответ `{accepted:false}`.

**Таймауты по слоям** (каждый следующий длиннее предыдущего):

| Слой                                                                              | Значение                   |
| --------------------------------------------------------------------------------- | -------------------------- |
| Координатор (карточка)                                                            | `expiresAt − 1 s` ≈ 299 с  |
| nanogate hold                                                                     | 300 с                      |
| nanogate проброс после одобрения                                                  | 60 с (`upstreamTimeoutMs`) |
| nanogate сокет (idle)                                                             | 600 с                      |
| Агент: per-server `timeout` (жёсткий, и с CLI v2.1.203 также нижняя граница idle) | 420 с                      |
| Агент: `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT`                                        | 420 с                      |
| Хост: `kill-ceiling`                                                              | 30 мин (не мешает)         |

Агент получает результат вызова. Результат приходит HTTP 200 как `result`, а не JSON-RPC `error`, чтобы модель прочитала текст:
`{"jsonrpc":"2.0","id":<id>,"result":{"isError":true,"content":[{"type":"text","text":"…"}]}}`. Тексты такие:

| Исход                                   | Текст для агента                                                                                                                           |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| denied                                  | «Владелец отклонил вызов `<tool>`. Не повторяй его, пока пользователь сам не попросит.»                                                    |
| expired                                 | «Нет подтверждения за 5 минут — вызов `<tool>` не выполнен. Скажи пользователю, что ждёшь подтверждения, и повтори только по его просьбе.» |
| unavailable                             | «Подтверждение сейчас недоступно (перезапуск или сбой доставки) — вызов не выполнен. Можно повторить позже.»                               |
| disabled / revoked                      | «Коннектор выключен или сессия отозвана — вызов не выполнен.»                                                                              |
| upstream сеть оборвалась после отправки | «Результат неизвестен: GitHub мог выполнить действие. Не повторяй автоматически — сначала проверь состояние.» (`status='unknown'`)         |

**Рестарт одной из сторон посреди ожидания:**

- _Агент умер или оборвал соединение_: `req.on('close')` → `decision='disconnected'`, запись снимается, `version++`. Хост вызывает
  `resolved(id)`, карточка снимается. Ничего не выполняется. Обрыв соединения означает отказ: спека не обязывает так делать,
  но выполнять вызов, результат которого уже некому вернуть, хуже.
- _Рестарт nanogate_: TCP рвётся, агент получает транспортную ошибку инструмента. Long-poll хоста падает, хост переподключается
  (since=0), список пуст, по всем известным id вызывается `resolved`, карточки истекают. MCP-сессия агента получает 404 и
  переинициализируется.
- _Рестарт хоста_: nanogate продолжает держать вызов. Новый `subscribe` получает его в списке с `createdAt` раньше старта
  и отвечает `unavailable`. Старая карточка в Telegram при нажатии не найдёт ожидающего: работает существующее поведение
  координатора для чужого `approval_id` (проверить тестом, что ответ «истекло»).
- _Сессию освободили или тенанта поставили на паузу_: `live.killToken` / `killTenant` → `destroy()` → `revoked`.
- _Коннектор выключили или удалили_: `rejectForConnector` → `disabled`.

### 4.3 Включение и выключение коннектора

1. Кабинет делает `PATCH /api/connectors/:id {enabled}`. Хост: проверка владельца и ключа → `patchConnector` → `pushConnector`
   (через `gateIdOf(tenant)`). Если push не прошёл, в ответе `status:'sync_error'`, БД остаётся изменённой, догонит `syncAllConnectors`.
2. Выключение действует сразу на уровне nanogate: новые вызовы получают 404 (MCP-клиент агента пометит сервер упавшим), ожидающие
   вызовы → `disabled`.
3. `markGroupConfigDirty(agentGroupId, 'connector toggled')` → kv `cfg-changed:<group>` = now, потом debounce → `applyConfigSweep()`.
4. `applyConfigSweep()`: для каждой сессии `getSessionsByAgentGroup(group)` с `status==='active'` и `isContainerRunning(id)`:
   если `getContainerStartedAtMs(id) < changedAt`, `!hasProcessingClaim(s)` и `countDueMessages()==0` (через
   `withExistingMailboxSession`) → `killContainer(id, 'config changed')` без пробуждения. Занятые сессии ждут следующего прохода (30 с).
   Остановленные трогать не нужно: `materializeContainerJson` запускается при каждом спавне.
5. При следующем сообщении в любом топике контейнер стартует со свежим `container.json`, и сервер `github` либо есть, либо его нет.
6. В Кабинете `applying = groupApplying(group)`: есть работающая сессия со стартом раньше `changedAt`. UI пишет «применяется к
   активным разговорам».

Тот же механизм используют навыки (§7), `readOnly`, сохранение и удаление ключа, а через `notifyConfigChanged` ещё и `add_mcp_server`.
`toolPolicy` перезапуска **не требует**: nanogate применяет его сразу.

### 4.4 Запись ключа из Кабинета

1. `PUT /api/connectors/:id/key {value}` → проверка `catalog.keyRe` (иначе 400 «Не похоже на токен GitHub»).
2. `nanogateAdmin.putSecret(gateIdOf(tenant), 'mcp.<id>', value)` → `pushConnector` (на случай, если коннектор ещё не синхронизирован)
   → `probeMcpConnector(id)`:
   - `key_rejected` → `deleteSecret`, `key_status='rejected'`, ответ 400 «GitHub не принял ключ».
   - `upstream_unreachable` / `upstream_error` → ключ остаётся, `key_status='unverified'`, ответ 200 с предупреждением в `status`.
   - `ok` → `key_status='ok'`, `tools` заполняются из `mcp_tools`.
3. `key_saved_at=now`. Если коннектор ни разу не включался (первый ключ), он включается сам → `markGroupConfigDirty`.
4. `audit(user_id,'connector_key_set',id)` без значения. В логах хоста значения нет: тело запроса не логируется, ошибки
   приводятся к коду.
5. Probe в nanogate: `initialize` (`protocolVersion:'2025-06-18'`, `clientInfo:{name:'nanogate'}`) → `notifications/initialized`
   → `tools/list` (до 5 страниц по `nextCursor`) → `upsertMcpTools(replaceAll=true)` → `DELETE` сессии. Используются те же
   `upstreamRequest` и разбор JSON или SSE.

---

## 5. Классификация инструментов

**Правило по умолчанию:** `asks(tool) = policy[tool] === 'ask' || (policy[tool] !== 'auto' && !(mcp_tools.read_only === 1))`.

- `read_only=1` выставляется только при `annotations.readOnlyHint === true` в ответе апстрима на `tools/list`. Ответ приходит
  из апстрима через nanogate, агент подделать его не может.
- Инструмента нет в `mcp_tools` (кэш пуст после нового коннектора, или апстрим добавил инструмент) → **опасный**.
- `destructiveHint` и имена инструментов не учитываются. Для GitHub это верно: `merge_pull_request` и `push_files` не помечены
  destructive, но и не read-only, значит попадут под подтверждение.
- Каталог GitHub-коннектора задаётся фиксированным URL и считается доверенным источником аннотаций. Для недоверенных серверов
  (этап 2, «подключи этот MCP») кэш read-only не используется: всё опасно, пока владелец не отметит инструмент `auto`.
  В Stage 1 нужен флаг `trustAnnotations` в `CatalogEntry`, но реализуется только ветка `true`.

**Как владелец меняет:** в Кабинете список инструментов коннектора разбит на две группы, «Спрашивать» и «Без подтверждения».
У каждого инструмента есть `Switch` «спрашивать». Если владелец его переключает, сохраняется `toolPolicy[tool]='ask'|'auto'`.
Кнопка «по умолчанию» отправляет `null`. Хост пушит `toolPolicy` в nanogate, и правило действует со следующего вызова.
Дополнительный рубильник «Только чтение» (`readOnly`) добавляет `X-MCP-Readonly: true`: GitHub перестаёт отдавать
пишущие инструменты вообще. Он меняет набор инструментов, поэтому вызывает `markGroupConfigDirty`.

---

## 6. GitHub и Groq

### 6.1 GitHub

```ts
{ id: 'github', serverName: 'github', title: 'GitHub',
  description: 'Репозитории, issues и pull requests от вашего имени.',
  url: 'https://api.githubcopilot.com/mcp/',
  keyRe: /^(ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{60,255})$/,
  keyLabel: 'Personal access token',
  keyHelp: 'Лучше fine-grained: выберите репозитории и права (Contents, Issues, Pull requests — Read/Write по необходимости). '
         + 'Классический токен: repo, read:org.',
  keyUrl: 'https://github.com/settings/personal-access-tokens/new',
  readOnlyHeader: 'X-MCP-Readonly', trustAnnotations: true }
```

- Апстрим получает `Authorization: Bearer <PAT>`. Accept, MCP-заголовки и тело передаются от агента как есть.
- Toolsets оставляем по умолчанию (путь `/`, без `X-MCP-Toolsets`): `context, repos, issues, pull_requests, users`, около 45
  инструментов. Схемы за tool search в контекст сами не грузятся. `X-MCP-Lockdown` не ставим.
- `readOnly=true` → `extra_headers = {"X-MCP-Readonly":"true"}`.
- Ошибки: 401/403 при probe → `key_rejected`. 403 у отдельного инструмента (нет прав на репо) — это ответ инструмента, а не ключа.
  Он идёт агенту как есть, ключ не помечается. Помечается он, только если 401/403 пришёл HTTP-статусом всего запроса.

### 6.2 Groq: свой ключ

- `groq-key.ts`:
  - `userKeyPath(userId)` = `<DATA_DIR>/secrets/groq/<user_id>`, директория 0700, файл 0600, запись атомарная, как сейчас.
  - `groqKeyCandidates(userId?)`: сначала `own(userId)`, потом существующие `miniapp` и `server`. `source` дополняется значением `'own'`.
  - `usableGroqKey(userId?)` и `resolveGroqKey(userId?)` получают опциональный аргумент. Механизм «парковки» ключа не меняется.
- `stt.ts`: в `transcribe` сделать `const t = await getTenantByTg(meta.userId)` и передать `t?.user_id` в оба вызова
  `usableGroqKey`. Повторная попытка при отказе уже перебирает кандидатов: свой ключ → общий → локальное распознавание.
- Семантика: существующий ключ владельца в Кабинете остаётся **общим** (override серверного для всех). Свой ключ есть у каждого
  тенанта, включая владельца, и действует только на его голосовые.
- API: `PUT/DELETE /api/secrets/groq-key` без `owner:true`. `connections` отдаёт `stt` всем: друзьям только `own` и признак
  «работает общий ключ», без `savedAt` общего.
- Удаление тенанта удаляет его файл.

---

## 7. Навыки: настоящий включатель

- **Хранилище:** существующее `container_configs.skills`. Новой таблицы нет.
- **Каталог для пользователя:** папки `container/skills/` без `HIDDEN_SKILLS`. Для друга доступно `FRIEND_SKILLS = ['agent-browser']`
  (вынести константу из `provision.ts:191` в экспорт), остальное `locked:true, enabled:false`. Владельцу доступно всё, кроме скрытых.
- **GET:** `enabled = selection === 'all' || selection.includes(id)`.
- **PUT `{enabled}`:** развернуть `'all'` в явный список, вызвав `selectedSkillNames`-эквивалент (все папки) с учётом текущего
  выбора, включая скрытые. Добавить или убрать `id`, остальное не трогать. Дальше `updateContainerConfigJson(group, 'skills', list)`,
  `markGroupConfigDirty(group, 'skill toggled')`, `audit`.
- **Применение:** при спавне `syncSkillSymlinks` пересобирает ссылки в `.claude-shared/skills/` и CLAUDE.md. Тестом проверить, что
  у выключенного навыка ссылка **удаляется** (`syncSharedSkillLinks(…, true)`), иначе `listInstalledSkills` его найдёт.
  Если не удаляется, чинить в `syncSharedSkillLinks`.

---

## 8. Тест-план

### 8.1 nanogate (`nanogate/test/mcp.test.ts`, vitest, `makeGate` + новый `fakeMcpUpstream`)

`fakeMcpUpstream` — HTTPS-сервер на loopback с самоподписанным сертификатом. Тесты добавляют его CA в `NODE_EXTRA_CA_CERTS`
или передают в `upstreamRequest` опцию `ca` (только для тестов, через `opts`) и включают `disableBuiltinDeny` для 127.0.0.0/8.
Сервер умеет `initialize` (с sid), `tools/list` (JSON и SSE, с аннотациями) и `tools/call`. Он считает вызовы и записывает
полученные заголовки.

Тесты (готово = все зелёные):

1. Без токена, с чужим токеном, с токеном другого тенанта или с выключенным коннектором → 401/404, апстрим не вызван.
2. Ключ подставлен, `Authorization` агента в апстрим не ушёл, `cookie` и `x-forwarded-*` срезаны, `www-authenticate` в ответе нет.
3. `Mcp-Session-Id` чужого токена → 404. После «рестарта» (`ctx.mcpSessions.clear()`) → 404.
4. SSE-ответ стримится: первое событие приходит до конца ответа.
5. `tools/list` заполняет `mcp_tools`, `read_only` берётся только из `readOnlyHint===true`.
6. Безопасный `tools/call` проходит сразу, `decision='auto'`.
7. Опасный: `GET /mcp-approvals` видит его. `approve` → ровно один вызов апстрима. `deny` → `isError` и 0 вызовов.
   Таймаут (`holdMs` = 200 мс в тесте) → `expired`. Обрыв клиента → `disconnected`. `release`/`revoke` → `revoked`.
   `PUT` с `enabled:false` → `disabled`. Повторный decision → `accepted:false`.
8. Лимиты ожиданий на тенанта и общий. Batch → 400. Тело больше лимита → 413.
9. Редирект апстрима не выполняется. URL на адрес из `denySet` (без `disableBuiltinDeny`) → ошибка, ключ не ушёл.
10. probe: `ok`, `key_rejected` (401), `upstream_unreachable`, `no_key`.
11. Значение секрета не встречается ни в логах (перехват `opts.log`), ни в `mcp_calls`, ни в ответах admin API.
12. `admin.test.ts`: валидация тела `PUT /mcp-connectors` (не https, недопустимый заголовок, неизвестный тенант).
13. `unit.test.ts`: `classify()` (правило §5) и сборка `args` displayFields (обрезка, маскирование, 12 полей).

### 8.2 nanorelay

`TestParseMap` дополнить картой из трёх маршрутов. Другого не нужно.

### 8.3 Хост — шлюзовый слой (`src/gateway-providers/nanogate/nanogate.test.ts`, `src/container-config.test.ts`)

1. Методы admin-client через временный сокет, плюс long-poll с `signal` (abort прерывает ожидание).
2. `subscribe`: фейковый сокет отдаёт pending → вызывается `decide` → уходит decision. Пропавший id → `resolved(id)`.
   Ошибка сокета → повтор без выхода из `subscribe`. Pending с `createdAt` раньше старта → `unavailable` без `decide`.
3. `parseRuntimeIdentity(gatewayRuntimeIdentity(x)) === x`.
4. `materializeContainerJson`: управляемый сервер добавлен после sanitize, перекрывает одноимённый сохранённый, проходит `timeout`.
   `parseMcpServerConfig` по-прежнему отвергает `http://nanorelay:8081/...`.
5. `agentEnv` содержит новые переменные, relay map содержит 8081.

### 8.4 Хост — наш слой (`src/nc/*.test.ts`)

1. `mcp-connectors.test.ts`: create/patch/delete. `managedServersFor` отдаёт сервер только при `enabled && key`. Сохранение ключа
   с `key_rejected` удаляет секрет. Первый ключ включает коннектор. Push использует текущий `gateIdOf`. `syncAllConnectors` досылает всё.
2. `config-apply.test.ts`: две сессии одной группы, одна с processing-claim. Sweep останавливает только простаивающую. После
   снятия claim следующий проход останавливает вторую. Сессию, запущенную после отметки, не трогает. Отметка переживает
   «рестарт» (kv).
3. `decideStuckAction`: tool_use-heartbeat после claim и 6 минут без событий → `ok` (удержанный MCP-вызов не убивается).
4. Кабинет (`miniapp/*.test.ts`): маршруты коннекторов — `owner`-only, тенант из сессии, значение ключа не попадает ни в ответ,
   ни в audit. Навыки: GET отдаёт выключенные, PUT разворачивает `'all'`, `locked` → 403. Groq: свой ключ друга не влияет на
   голосовые владельца, при парковке своего ключа используется общий.
5. `stt.test.ts`: выбор ключа по `meta.userId`.
6. self-mod: после `applyAddMcpServer` вызывается `notifyConfigChanged`.

### 8.5 agent-runner

Юнит на функцию подстановки заголовка (вынести `withGatewayAuth(servers, env)` в отдельный модуль): заголовок ставится только
по префиксу, не ставится без ключа, остальные серверы не меняются.

### 8.6 Кабинет (frontend)

`npm run build` в `miniapp/` проходит. Типы `cmp`-идентичны с `src/nc/miniapp/types.ts`. На моках экраны «Коннекторы» и «Навыки»
работают: переключатели, ввод и удаление ключа, ошибки 400/409.

### 8.7 Общий критерий «готово»

`npm test` (корень), `vitest run --root .. nanogate`, `go test ./...` в `nanorelay`, сборка miniapp и `nix flake check` в nixserver
(после бампа) — всё зелёное. Значения секретов не встречаются в `container.json`, логах и ответах (тесты выше).

### 8.8 Ручная проверка после деплоя

1. В Кабинете → «Коннекторы» → GitHub: ввести неверный токен → «GitHub не принял ключ». Ввести верный fine-grained PAT
   на тестовый репо → статус «ок», появился список инструментов.
2. Написать агенту «какие у меня открытые issues в <repo>» → ответ без карточки. В «последних вызовах» строка `auto/ok`.
3. «Создай issue "test stage1" в <repo>» → карточка в личке. «Отклонить» → агент сообщает об отказе, issue нет. Повторить и нажать
   «Одобрить» → issue создан. Повторить и не нажимать 5 минут → агент сообщает о таймауте, контейнер жив.
4. Открыть второй топик до включения коннектора. Включить коннектор, подождать до 1 минуты без сообщений во втором топике. Написать
   туда → там тоже есть `github`.
5. Выключить коннектор → в Кабинете «применяется…», агент через минуту не видит GitHub.
6. `cat groups/<folder>/container.json` на сервере (только чтение) → нет ключа и токена.
7. Выключить и включить навык «Браузер» → поведение агента меняется в новых разговорах.
8. Друг сохраняет свой ключ Groq → его голосовое распознаётся, в журнале `source=own`.
9. `journalctl` nanogate: строки `mcp_call` без аргументов и ключей.

---

## 9. Рабочие пакеты

Четыре пакета, файлы не пересекаются. Контракт между ними — §3 этого документа. Каждый пакет пишет собственные тесты.

**WP-A — nanogate + nix + nanorelay test.** Файлы: `nanogate/src/{config,db,tokens,context,server,admin-api}.ts`, новые
`mcp-proxy.ts`, `mcp-approvals.ts`, `mcp-upstream.ts`, экспорт `checkPublicAddresses` из `connect-proxy.ts`, `nanogate/test/*`,
`nix/module.nix` (одна строка listen), `nix/nanogate-image.nix`, `nanorelay/main_test.go`.
Выход: admin API §3.2 и HTTP `/mcp/:id` §4.1–4.2. Ни от кого не зависит.

**WP-B — шлюзовый слой хоста и runner.** Файлы: `src/gateway-providers/nanogate/{admin-client,index}.ts` и их тесты,
`src/container-config.ts` (+ тест), `container/agent-runner/src/{index.ts, providers/types.ts}` и новый
`container/agent-runner/src/gateway-auth.ts` (+ тест).
Выход: методы `nanogateAdmin.*Mcp*`, `subscribe`, хуки `setManagedMcpServersProvider`/`setConfigChangedListener`/`notifyConfigChanged`,
env. От WP-A зависит только контракт. Тесты используют фейковый сокет.

**WP-C — наш слой хоста (бэкенд Кабинета, применение, Groq).** Файлы: `src/nc/{migrations,mcp-catalog,mcp-connectors,config-apply,
commands,index,platform,lifecycle,budget,groq-key,stt,provision}.ts`, `src/nc/miniapp/{api,connectors-api,types}.ts`,
`src/modules/self-mod/apply.ts`, тесты в `src/nc`.
Зависимость от WP-B: имена хуков и методов admin-client из §2.4 и §3.2. Пока WP-B не готов, в тестах используются стабы
`vi.mock` для `nanogateAdmin`. Изменение в `budget.ts` — только ветка по `type==='mcp_key_rejected'`.

**WP-D — frontend Кабинета.** Файлы: `miniapp/src/**` (`screens/Connectors.tsx`, `Skills.tsx`, `Connections.tsx`, `router.ts`,
`App.tsx`, `screens/Home.tsx`, `api/types.ts`, `api/extra.ts`, `api/mock.ts`). Работает на моках по типам §3.3.
От других пакетов не зависит.

**Порядок:** A, B, C, D идут параллельно. Интеграция в конце: (1) A+B — сквозной тест на хосте с настоящим nanogate из
`nanogate/test/harness.ts` и fake upstream (дополнительный тест в WP-B после слияния), (2) `cmp` типов C/D, (3) полный прогон §8.7,
(4) один деплой и §8.8.

**Ответственность на стыках:**

- Формат `sessionKey` знает только WP-B (`parseRuntimeIdentity`).
- Тексты `isError` для агента пишет WP-A (§4.2, таблица). Тексты для Кабинета пишет WP-C.
- `serverName` → имя записи в `container.json` определяет WP-C через `managedServersFor`. WP-B только вливает готовую запись.

---

## 10. Открытые вопросы к владельцу

Блокирующих нет. Ниже приняты значения по умолчанию, владелец может их поменять:

1. Коннекторы в Stage 1 видит только владелец (§1.1 п.9). Для друзей это один флаг и `approverUserId`, сделаем после проверки на себе.
2. Карточка подтверждения приходит в личку владельца, а не в топик, где идёт разговор. Причина: `delivery` в координаторе требует
   `approverUserId`, а так поведение проще и предсказуемее.
3. Ключ Groq, который владелец сохранил в Кабинете, остаётся общим для всех (как сейчас). У каждого появляется ещё и «свой ключ».

---

## 11. Поправки после критики Codex (имеют приоритет над разделами выше)

1. **Отключение клиента** определяется по `res.on('close')` при `!res.writableFinished`, а не по `req.on('close')`. После ответа слушатели снимаются. Нужен тест: POST дочитан полностью, ответ ещё держится, удержание при этом не отменяется.
2. **Сессии MCP** выдаёт сам nanogate: `Mcp-Session-Id` шлюза хранит привязку к тенанту и коннектору и, если upstream его вернул, к upstream-id. Upstream без session id (stateless) поддерживается. Нужна фикстура upstream без заголовка.
3. **Применение к сессиям** — дополнительная обязанность существующего `host-sweep.ts`, а не отдельный таймер. Для усыновлённых после рестарта хоста контейнеров время старта берётся настоящее (из рантайма). Если его не получить, контейнер считается запущенным до любой отметки. Нужен тест на усыновление.
4. **Синхронизация с nanogate — полная замена инвентаря тенанта.** Чего нет у хоста, удаляется в шлюзе вместе с секретом. Сбой удаления исправляется на следующем проходе.
5. **Ревизия коннектора.** У коннектора есть счётчик `rev`, он растёт при любой смене ключа, URL, заголовков, политики или переключателя «только чтение». Удержанный вызов запоминает `rev` и перед отправкой upstream сверяет его. Если ревизия изменилась, вызов отклоняется: «настройки коннектора изменились, повтори».
6. **SSE и отмена.**
   - Потоки не возобновляемые: на GET шлюз отвечает 405, `Last-Event-ID` не поддерживается, и это записано явно.
   - `notifications/cancelled` для удержанного вызова (сессия + request id) снимает удержание и гасит карточку; upstream не вызывается.
   - Переподключение закреплённого Claude Code после рестарта шлюза проверяем тестом или вручную после деплоя. Встроенное восстановление по 404 не предполагаем.
7. **Upstream-дедлайн абсолютный: 60 с** на DNS, соединение, заголовки и всё тело, через `AbortController`. При потере нижнего клиента upstream прерывается. Если обрыв случился после отправки, ответ «результат неизвестен».
8. **Новый ключ проверяется до записи:** in-memory проба `initialize` + `tools/list` с кандидатом. Если проба не прошла, старый ключ остаётся, ответ 400 с причиной.
9. **Аргументы в карточке.**
   - Рекурсивная маскировка полей с именами `token|secret|password|key|authorization`.
   - Длинные строки обрезаются.
   - Что аргументы хранятся в `pending_approvals.question` (удаляются вместе с записью), записано явно.
10. **Groq:** перебор всех различных кандидатов (свой → общий из Кабинета → серверный) в пределах общего дедлайна, а не один повтор. Ключи хранятся файлами на хосте, admin API на чтение секретов не делаем.
11. **Контракты до разделения пакетов.**
    - `status` коннектора: `'ok' | 'no_key' | 'key_rejected' | 'upstream_error' | 'disabled'` плюс необязательная строка `warning`.
    - Для Groq у пользователя: `{ own: boolean, sharedAvailable: boolean }`.
    - Типы живут в `src/nc/miniapp/types.ts`, фронтенд их зеркалит.
    - Действующие проверки Кабинета (Bearer, CSRF, epoch, owner) сохраняются.
12. **Решения §10 приняты как значения по умолчанию.**
