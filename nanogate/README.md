# nanogate

The only holder of the Anthropic API key. It authenticates per-session bearer tokens, enforces per-tenant
model / budget / egress policy, meters usage into a SQLite ledger, and runs an SSRF-safe CONNECT proxy
with optional per-tenant SOCKS5 connector routing. Standalone package: no imports from `src/`;
runtime dependency is `better-sqlite3` only. Node 22+.

## Run

```bash
pnpm exec tsc -p nanogate/tsconfig.build.json     # -> nanogate/dist/
NANOGATE_CONFIG=/etc/nanogate/config.json node nanogate/dist/main.js
pnpm exec vitest run nanogate                      # tests (no network)
pnpm exec tsc --noEmit -p nanogate                 # typecheck (src + tests)
```

`SIGHUP` re-reads the config, key files, prices and deny sets (listeners are not rebound).
Env overrides: `NANOGATE_ADMIN_SOCKET`, `NANOGATE_BIND`, `NANOGATE_ANTHROPIC_PORT`,
`NANOGATE_CONNECT_PORT`, `NANOGATE_HOST_PORT`.

## Listeners

| Listener | Default | Purpose |
|---|---|---|
| Anthropic proxy | `:8080` | `POST /anthropic/v1/messages`, `.../count_tokens` with session tokens (`ngs_`); `GET /healthz` |
| CONNECT / HTTP proxy | `:3128` | `Proxy-Authorization: Basic base64(x:<token>)` or `Bearer <token>` |
| Host-caller port | `127.0.0.1:8090` | same Anthropic path, host tokens (`ngh_`) only |
| Admin | unix socket, mode 0600 | JSON admin API below |

## Config (JSON)

Required: `anthropicKeyFile`, `stateDir`, `encryptionKeyFile` (32 bytes hex/base64), `prices`.
Prices are never in code: `prices.models.<model>` = `{input, output, cacheWrite5m, cacheWrite1h, cacheRead}` (USD per million
tokens), `prices.serverTools.<name>` = USD per use, plus a `prices.version` string. A model absent from the table is not allowed.

Optional: `upstream` (default `https://api.anthropic.com`), `denyCidrs`, `hostAddresses` (never reachable, not even
through connector routes), `globalCapUsdMicros` (per UTC month, all tenants; default none), `connectLimits`
`{maxTunnelsPerTenant 64, maxTunnelsGlobal 256, maxTunnelSeconds 3600, maxBytesPerTunnel 2 GiB, idleSeconds 300, dnsPerTenant 4 (must be < dnsGlobal), dnsGlobal 16, dnsTimeoutMs 5000, dnsQueuePerTenant 64, dnsQueueGlobal 512}` (DNS is c-ares, not libuv's pool; lookups beyond the caps wait FIFO inside dnsTimeoutMs, 429 only when the tenant queue is full, 503 when the process-wide queue is; each lookup is cancelled at dnsTimeoutMs),
`anthropicLimits` `{bodyTimeoutMs 60000, maxInflightBodyBytes 160 MiB (bytes counted as they arrive, plus 3x the raw size while the body is processed; only the outgoing copy is held until the upstream write finishes; sized for the 512m container), maxInflightBodyBytesPerTenant 128 MiB (one maximal 32 MiB body needs 4x = 128 MiB), socketIdleMs 600000, maxConnections 2048, upstreamHeadersTimeoutMs 120000 (streaming requests), upstreamNonStreamTimeoutMs 600000 (non-streaming), streamIdleMs 300000,
capWindowMinutes 15, serverToolDefaultMaxUses 5, serverToolMaxUses 10, serverToolResultInputTokens 25000}`, `modelHosts`
(default `["anthropic.com"]`, suffix-matched), `defaultBetas`, `socksTimeoutMs`,
`listen` `{bind, anthropicPort, connectPort, hostPort, adminSocket}`.
`disableBuiltinDeny` removes built-in deny CIDRs and exists for tests only.

### Tenant policy (`PUT /tenants/:id`)

`models`, `maxTokens` (clamped), `allowServiceTiers`, `betas`, `serverTools` (prefix match), `allowSpeed`,
`maxConcurrentRequests`, `perTurnCapMicros` (name kept for compatibility; it is a **rolling-window cap**: spend of this
session token over the last `anthropicLimits.capWindowMinutes`, computed from the ledger plus its open reservations, so
nothing the agent sends can reset it), and `egress`:
`route` (`direct`|`connector`), `fallbackDirect`, `ports` (public), `tailnet`, `tailnetAllow`
(`"<cidr|ip|host|*.suffix>:<port|*>"`; a tailnet destination must match this list AND, for IPs, lie inside the
requesting tenant's own connector routes), `connectorTenant` (tenant whose connector carries this tenant's *public*
`route:'connector'` traffic; default self; tailnet traffic always uses the requester's own connector).
Names in `tailnetAllow` must be MagicDNS FQDNs (`host.x.ts.net`, or `*.x.ts.net`) or single labels; anything else is rejected.

Server tools (`serverTools`) must also have a `prices.serverTools` entry, else the request is a 400 (`server_tool_unpriced`).
`max_uses` is injected (default 5) when absent and clamped (10) for web_search/web_fetch only; web_fetch also gets `max_content_tokens` (injected/clamped to `serverToolResultInputTokens`). url/file_id sourced documents and images are refused (`remote_source_not_allowed`). bash_/text_editor_/memory_/computer_ tools are client-executed and pass untouched. Each allowed use reserves its price plus
`serverToolResultInputTokens` of input at the model's dearest rate, and the input estimate is body bytes / 2.

### Attribution

`usage.purpose` is never taken from a request header: session tokens record `agent`, host tokens the purpose they were
minted with. `x-nanogate-turn` is stored as an informational label only.

## Admin API

| Method + path | Notes |
|---|---|
| `GET /healthz` | 200/503; reports upstream key readable, db writable |
| `PUT /tenants/:id` | upsert `{kind, status?, policy, budgetLimitMicros\|null, periodTz}` |
| `POST /tenants/:id/pause` `/resume` `/revoke` | pause/revoke kill live tunnels (including ones still resolving/dialling); revoke also bumps epoch, revokes tokens, aborts in-flight requests (including ones still uploading their body) and returns the `killed` count. `PUT /tenants/:id` with a changed policy drops that tenant's tunnels |
| `POST /sessions/ensure` | `{tenantId, sessionKey, runtimeIdentity, disposition:'create'\|'adopt'}` -> `{token, created}`; adopt never mints (409 `no_session_token`) |
| `POST /sessions/release` | `{sessionKey, kind:'session-ended'\|'host-detached'}` |
| `GET /sessions` | live session keys + runtime identities |
| `POST /sessions/reconcile` | `{liveSessionKeys}` -> `{revoked:[...]}` |
| `POST /host-tokens`, `DELETE /host-tokens/:hashPrefix` | purposes `stt guest miniapp system` |
| `GET /usage?tenantId=&from=&to=&groupBy=day\|model\|purpose\|session` | micros; `from`/`to` epoch ms or ISO |
| `GET /budget/:tenantId` | `{limitMicros, usedMicros, reservedMicros, periodStart, periodEnd, status}` |
| `GET /events?after=` , `POST /events/ack {upTo}` | `budget_80`, `budget_100`, `global_cap` |
| `PUT /secrets/:tenantId/:name {value}`, `DELETE ...`, `GET /secrets/:tenantId` | write-only; GET lists names + `updatedAt` |
| `PUT /connectors/:tenantId`, `DELETE /connectors/:tenantId` | `{socksAddr, status:'up'\|'down', routes:{cidrs, exitNode}}`; cidrs no broader than /8 (v4) or /16 (v6), no `0.0.0.0/0`, `::/0` or IPv4-mapped forms (400 `bad_cidrs`). A change of address/routes/status, or DELETE, drops the tunnels it carries |

## Notes

- Budget reservations are taken in a `BEGIN IMMEDIATE` transaction; reservations left open by a crash are charged
  as `estimated` on the next start.
- Any stream that does not end in a final `message_delta` (client abort, upstream cut, `error` event, idle or
  header timeout) is charged at `max(observed usage, full reservation)` (`estimated`); only a completed stream is
  charged actual usage.
- Settlement failures (SQLite errors) are logged (metadata only) and leave the reservation open; the 60 s sweep
  charges it at the reserved amount. Requests still in flight are never swept.
- Requests register in the live registry right after authentication and re-validate the token/tenant right before
  dialling / forwarding, so revoke, pause and session release also stop requests that are still resolving, dialling
  or uploading a body. Tunnel slots are taken at that point too (pending tunnels count toward `maxTunnelsPerTenant`).
- Request bodies: per-tenant concurrency is checked before the body is read, bytes are accounted against a global cap,
  and the body must arrive within `bodyTimeoutMs` (413 / 429 / 408).
- Deny sets: loopback, link-local, `0.0.0.0/8`, multicast and `hostAddresses` are denied even inside connector
  routes. Direct dials try every validated address (IPv4 first) with a per-attempt timeout.
- Tailnet names: a name is handed to the connector unresolved, so what it maps to is decided by the connector's
  resolver. nanogate only allows names that match an allowlist entry; the backstop for a name that maps outside the
  tailnet is the host firewall on the connector uplink network (it must not reach RFC1918/CGNAT beyond what tailscale
  needs, host addresses, the AWG subnet or podman pools).
- Bodies, prompts and keys are never logged.

## Notes on defaults

- Default model allowlist (policy without `models`): `claude-haiku-5-5` (WebFetch, Explore subagents), `claude-sonnet-5-5`, `claude-opus-5-5`. Every listed model also needs a price in the price table, or requests are rejected.
- Budget hard stop: a refusal on the worst-case reserve records `budget_100` (once per period and limit) and `/budget/:tenant` reports `exhausted` until the limit is raised. Budget and global-cap 429s carry `x-should-retry: false` and `retry-after`.
- Host-token callers (guest, stt, ...) have their own pool of 2 concurrent requests per tenant, separate from `maxConcurrentRequests`.
- `POST /sessions/ensure` accepts an optional `purpose: 'task'` so scheduled-task spend is recorded as `task` (default `agent`).
- Tunnels: `maxTunnelsPerTenant` 64, `maxTunnelsGlobal` 256.
- The provider env sets `NODE_USE_ENV_PROXY=1`; Node < 22.21 / < 24 ignores it, so Node tools there get no internet through the proxy.
