# Nix packaging and NixOS module

`flake.nix` at the repo root builds every deployable piece of the fork and exports
`nixosModules.nanoclaw`. Target: `aarch64-linux` (nuremberg). `x86_64-linux` evaluates;
`aarch64-darwin` exposes the pure builds (host, nanogate, nanorelay, Mini App) for local checks.

```sh
nix build .#packages.aarch64-linux.nanorelay          # from the Mac, via the configured aarch64 builder
nix build .#packages.aarch64-linux.nanoclaw-host
nix build .#packages.aarch64-linux.nanoclaw-agent-image
nix flake check                                       # evaluates the module (both firewall backends) and runs the smoke tests
```

Flakes only see **tracked** files. `git add` new files before building from a git checkout.

## Packages

| Output | What | How |
| --- | --- | --- |
| `nanoclaw-host` | Root pnpm project: `dist/` (tsc), production `node_modules`, `container/`, `templates/`; `bin/nanoclaw-host`, `bin/ncl` | `pnpm_10.fetchDeps` + `configHook`, `pnpm build`, `pnpm prune --prod`. `better-sqlite3` is N-API with upstream prebuilds; `autoPatchelfHook` points the linux one at nixpkgs libstdc++. Wrappers run `node dist/...` without changing cwd. |
| `nanoclaw-runner-src` | `container/agent-runner` `src/` + Bun `node_modules` | `bun install --frozen-lockfile` in a fixed-output derivation (per-system hash). Only the SDK's native package for the target arch is kept. |
| `nanoclaw-agent-image` | Streamed OCI image for agents | See "Agent image". |
| `nanogate` | `nanogate/` compiled with the root toolchain + a `better-sqlite3`-only runtime tree; wrapper uses slim Node | Shares the root pnpm store: nanogate has no importer in `pnpm-lock.yaml`, its single dependency is pinned identically to the root's. |
| `nanogate-image` | slim Node + nanogate, uid 65532, volume `/var/lib/nanogate` | `streamLayeredImage` |
| `nanorelay`, `nanorelay-image` | static Go binary (`CGO_ENABLED=0`) and a scratch-like image, uid 65532 | `buildGoModule` (`vendorHash = null`) |
| `nanoclaw-miniapp` | Vite build, static `dist/` | pnpm workspace filter `@nanoclaw/miniapp` |
| `nanoclaw-tailscale-image` | nixpkgs tailscale, userspace networking + SOCKS5, uid 65532 | for the optional owner connector |
| `whisper-model-small`, `whisper-model-large-v3-turbo-q5_0` | ggml models, pinned HF revision | `fetchurl` |

Image tags are deterministic: `<name>:<version>-<8 hex of the hash of the image's store paths>`
(`nanoclaw-agent:2026.10.0-3f9a1c2e`). The agent image is not a tarball in the store; it is a
stream script (`streamLayeredImage`), so the store holds layers once.

### Agent image: approach and why

The agent image is assembled from nixpkgs, **not** from the Debian `Dockerfile`.
`podman build` of the Dockerfile cannot be pinned (apt without a snapshot, `curl | bash` for Bun,
npm registry at build time) and a `pullImage` of `node:22-slim` still needs apt for Chromium.
Instead:

- nixpkgs: bash, coreutils, findutils, grep, sed, awk, tar, gzip, unzip, curl, git, tini, ripgrep,
  procps, less, Node 22 + npm, pnpm 10, **chromium** (+ Liberation and Noto emoji fonts via
  `FONTCONFIG_FILE`), CA bundle.
- **Document tooling** (podman cannot rebuild images, so runtime installs are impossible): `python3` with
  openpyxl, python-docx, pypdf, pillow, pillow-heif, plus `poppler-utils` (pdftotext, pdftoppm). Rough cost:
  poppler ~150 MiB closure, python libs + libheif ~100-150 MiB on top of bare python. pandoc (~200 MiB) and
  libreoffice are left out on purpose.
- **Locale/browser**: `LANG=ru_RU.UTF-8` (a trimmed ru_RU+en_US glibc locale archive), `TZDIR` for tzdata (the host
  passes `TZ` at spawn), and `AGENT_BROWSER_PROFILE=/workspace/agent/.browser-profile` (inside the bind-mounted group dir, so logins survive container restarts), and an `/etc/hosts` with `localhost` (agents run with `--no-hosts`).
- `/pnpm/claude` (+ `/pnpm/agent-browser`) symlinks: the Claude SDK is started from `/pnpm/claude`.
- **Bun 1.4.0**: the official release zip by hash (same pin as the Dockerfile's `BUN_VERSION`).
- **claude** (2.1.280) and **agent-browser** (0.27.1): the npm tarballs by integrity hash.
  Both ship prebuilt per-platform binaries, so unpacking is the whole install (postinstall is a
  copy). Versions are asserted against `container/cli-tools.json` at eval time; a bump there makes the
  build fail until `nix/cli-tools.nix` is updated.
- The SDK's bundled CLI and the global `claude` are byte-identical; the image keeps one copy.
- Upstream's glibc binaries (Bun, `claude`, `agent-browser`) are **not patched** (`patchelf` damages
  Bun-compiled executables). The image provides `/lib/ld-linux-aarch64.so.1` and sets
  `LD_LIBRARY_PATH` to the glibc dir instead.
- Path contract kept: `/app/src` (bind-mounted by the host), `/app/node_modules`, `/app/entrypoint.sh`,
  `/workspace/{group,extra}`, user `node` (1000), `/usr/local/bin/ncl`, upstream's `entrypoint.sh`
  under `tini`. Labels: `dev.nanoclaw.agent-runner-lock-sha256`, `dev.nanoclaw.image-source=nix`.

Not reproduced: `INSTALL_CJK_FONTS`, `corepack`/`npm@10.9.9` pin (nixpkgs ships its own npm), the
setuid strip (nothing in a nix image is setuid).

### Updating hashes

- `pnpm-lock.yaml` changed: `nix/pnpm-deps.nix` -> `hash = lib.fakeHash;`, build `nanoclaw-host`,
  paste the reported hash.
- `container/agent-runner/bun.lock` changed: same, in `nix/runner-src.nix` (`nodeModulesHashes`).
- cli-tools bumped: update version + `npm view <pkg>@<v> dist.integrity` in `nix/cli-tools.nix`.

## NixOS module: `services.nanoclaw`

```nix
{
  inputs.nanoclaw.url = "github:mois-ilya/nanoclaw";   # this repo
  inputs.nanoclaw.inputs.nixpkgs.follows = "nixpkgs";

  # nixosConfigurations.nuremberg modules = [ inputs.nanoclaw.nixosModules.nanoclaw ... ];
  services.nanoclaw = {
    enable = true;
    installId = "nuremberg-prod";
    ownerTelegramId = 42582289;
    telegram.tokenFile = config.sops.secrets."nanoclaw/telegram_bot_token".path;
    anthropicKeyFile   = config.sops.secrets."nanoclaw/anthropic_api_key".path;
    nanogate = {
      encryptionKeyFile = config.sops.secrets."nanoclaw/nanogate_key".path;
      pricesFile = ./nanoclaw-prices.json;       # optional override, see "Prices" below
      hostAddresses = [ "46.224.210.43" ];
      denyCidrs = [ "10.201.0.0/20" ];            # AWG
    };
    miniapp = { enable = true; domain = "claw.mois.pro"; };
    stt.enable = true;
  };
}
```

The package options default to `inputs.nanoclaw.packages.<system>.*` of the flake that provides the module,
so the consumer pins the code by bumping the flake input. Every package/image is overridable.

Options (all under `services.nanoclaw`): `enable`, `package`, `agentImage`, `stateDir`, `layout`,
`installId`, `ownerTelegramId`, `webhookPort`, `telegram.tokenFile`, `anthropicKeyFile`,
`nanogate.{package,image,encryptionKeyFile,pricesFile,globalCapUsd,denyCidrs,hostAddresses}`,
`nanorelay.image`, `network.{sessionPool,servicePool,svcSubnet,egressSubnet,connOwnerSubnet,connUplinkSubnet}`,
`firewall.{backend,hostAddresses,vpnSubnets}`, `resources.{sliceMemoryMax,sliceMemoryHigh,agentMemory,agentCpus,shmMb,tmpMb,maxConcurrent}`,
`idle.{ownerMinutes,friendMinutes}`, `timeZone` (host `TZ` + `NC_DEFAULT_TZ`, default `Europe/Moscow`, independent of the server `time.timeZone`), `stopButton` (default on, `NC_STOP_ENABLED=1`),
`botName`/`ownerName`/`ownerNameGen`/`models.{fast,normal,deep,guest,small}` (optional `NC_BOT_NAME`/`NC_OWNER_NAME*`/`NC_MODEL_*`; unset keeps the code defaults),
`nanogate.upstreamNonStreamTimeoutMs` (default 600000), `miniapp.{enable,package,domain,apiPort,shortName}`,
`stt.{enable (default true),package,model,port,threads,memoryMax}`, `tailscale.owner.{enable,image,authKeyFile,exitNode (default `gl-mt3000-beryl`; null = none),tailnetCidrs,tailnetAllow}`, `alertCommand` (`NC_ALERT_COMMAND`, default unset),
`backup.{enable,dir,keep}`, `extraEnv`.

### Prices

`nanogate.pricesFile` defaults to `nix/default-prices.json`, which covers `claude-haiku-5-5`,
`claude-sonnet-5-5`, `claude-opus-5-5` and the server tools of the default policy (`web_search`,
`web_fetch`). **Its numbers are placeholders (`version` starts with `UNVERIFIED`): verify every value
against anthropic.com/pricing before the first real deploy** and pass your own file via
`nanogate.pricesFile`. A model absent from the table costs 0 in the budget, so any model set through
`models.*` must be in the table. `module-eval` checks that the default file lists the models and tools above.

### Mini App short name

`miniapp.shortName` must match the short name in BotFather -> Configure Mini App. Without it the adapter
uses native `web_app` buttons, which Telegram only allows in private chats (no group/channel links);
the module prints a warning when `miniapp.enable` is on and `shortName` is unset.

### Units

| Unit | Role |
| --- | --- |
| `podman.socket` (drop-in) | `SocketGroup=podman`, `SocketMode=0660`. User `nanoclaw` is in `podman`. **That is root-equivalent**: the host process is trusted; agents never see the socket. |
| `nanoclaw-images.service` | oneshot: `podman image exists` else stream-load; verifies architecture; removes superseded tags. Idempotent. |
| `nanoclaw-networks.service` | oneshot: `nanogate-svc` (`--internal`), `nanogate-egress` (NAT bridge), and for the connector `conn-owner` (internal) / `conn-uplink`. Verifies subnet and `internal`; a mismatch fails the unit. |
| `nanogate.service` | `podman run` (uid 65532, read-only, no caps, `-p 127.0.0.1:8090:8090`). Secrets via `LoadCredential`, copied to a private tmpfs dir and bind-mounted read-only; config.json is the Nix-generated base merged with `pricesFile` at start. After start, an ACL grants the `nanoclaw` user (and only it) the admin socket; the socket itself is 0600 and `/run/nanogate` is 0700. |
| `nanoclaw.service` | User `nanoclaw`, `WorkingDirectory=stateDir`, `Slice=nanoclaw.slice`. `ExecStartPre` (root): link/copy the release into the state dir and check the asset manifest; if the build id changed, take a pre-upgrade backup and stamp `data/upgrade-state.json` (`{version, buildId}`; upstream's tripwire compares those when `NANOCLAW_BUILD_ID` is set). DB migrations run inside the host at startup (there is no separate migrate command). Hardened: `ProtectSystem=strict`, `PrivateTmp`, `NoNewPrivileges`, ... |
| `nanoclaw.slice` | `MemoryHigh`/`MemoryMax`; the driver passes `--cgroup-parent=nanoclaw.slice` (`NANOCLAW_CGROUP_PARENT`). nanogate stays outside the slice on purpose. |
| `nanoclaw-stt.service` | `whisper-server --convert --tmp-dir /tmp` on 127.0.0.1:8091 (the unit's cwd is read-only, so the ffmpeg temp file needs `--tmp-dir`), `DynamicUser`, `IPAddressDeny=any` + loopback, `MemoryMax`, in the slice. |
| `nanoclaw-ts-owner.service` | optional tailnet connector container (`--accept-routes` when `tailnetCidrs` is set). nanogate joins `conn-owner` directly in its own `podman run`, so the attachment survives restarts. The host registers it with nanogate (`NC_OWNER_CONNECTOR_SOCKS=nanoclaw-ts-owner:1055`). |
| `nanoclaw-backup.{service,timer}` | nightly: SQLite `.backup` of the central DB, nanogate DB and every session DB, `groups/` tarball, keep N. Pre-upgrade snapshots use the same script. |

### Firewall (host rules by role)

`firewall.backend = "auto"` follows `networking.nftables.enable`. **nuremberg uses the iptables
NixOS firewall** (`networking.firewall`, nftables not enabled; AWG adds its own iptables rules), so
the module appends to `networking.firewall.extraCommands` / `extraStopCommands`: two dedicated chains,
`nanoclaw-in` and `nanoclaw-fwd`, re-created idempotently and jumped to from the top of `INPUT` and
`FORWARD`. Nothing else is flushed or edited. (Netavark's own `inet netavark` nftables table coexists:
both are evaluated for every packet, a drop in either wins.) With the nftables backend the same rules
land in a separate `table inet nanoclaw`.

Rules (all verdicts are "drop" or "no objection", never a global accept):

- INPUT: established replies pass; aardvark DNS (53) on each bridge gateway passes; everything else
  from the session pool and from the service/uplink subnets is dropped.
- FORWARD: established passes; session pool -> anything outside the pool dropped; anything outside the
  pool -> session pool dropped; internal service subnets -> outside themselves dropped; the NAT uplinks
  (egress, conn-uplink) -> host addresses, VPN subnets, session/service pools and RFC1918/CGNAT/link-local
  dropped (public internet allowed).

`nanoclaw` asserts that netavark's `firewall_driver` is not `none` (that setting removes the isolation
rules of `--internal` networks).

## Consumer wiring (nixserver)

- Add the flake input with `inputs.nixpkgs.follows = "nixpkgs"` and import `nixosModules.nanoclaw`
  next to the existing podman/containers module (`my.services.containers.enable`).
- The old `inputs.nanoclaw.nixosModules.{default,onecli}` / `services.onecli` are replaced by this module.
- sops secrets: telegram token, Anthropic key, `nanogate_key` (32 random bytes, hex), optionally the
  tailscale auth key. Files are read by systemd (`LoadCredential`), so they may be root-owned `0400`.
- The Mini App vhost needs `services.caddy.enable = true` and only takes effect with the stock Caddy config. A consumer that sets its own `services.caddy.configFile` (nixserver on nuremberg: layer4 SNI router on :443, internal listener :8443) must copy `config.services.caddy.virtualHosts.${miniapp.domain}.extraConfig` into its Caddyfile, otherwise the TLS handshake for the Mini App domain fails.

## Known gaps / verify on the server

- nanogate's `listen.hostBind` is implemented (default 127.0.0.1); the module emits `"0.0.0.0"` so
  `-p 127.0.0.1:8090:8090` reaches the host-caller listener.
- The admin socket is created 0600 by nanogate (owner 65532); the module grants the `nanoclaw` user an
  ACL after start. A `NANOGATE_ADMIN_SOCKET_MODE`/GID option in nanogate would remove the ACL dance.
- Port publishing and DNS on `--internal` networks under netavark's nftables driver; the iptables chains
  vs netavark's `inet netavark` table under load (Spike B); the acceptance test must originate traffic from
  each role.
- `layout = "symlink"` vs bind-mount admission (Spike H). Switch to `"copy"` if mounts are refused.
- `NC_IDLE_*_MINUTES`, `NC_MAX_CONTAINERS` and `NANOCLAW_CGROUP_PARENT` are emitted and enforced by the host (`src/lifecycle-policy.ts`, `src/spawn-admission.ts`, `src/drivers/podman-driver.ts`). Warm idle containers count against `resources.maxConcurrent` (default 2): a wake over the cap waits (owner first) and the host stops an idle container (friend first, then the longest quiet) to free a slot.
- Running the agent image itself (chromium sandbox flags, fonts, `agent-browser` proxy config) needs a real
  `podman run` on the server; the smoke test only proves the binaries and runner deps start.

## Host templates and Mini App caching

- `src/nc/templates/*.md` are installed to `<host>/lib/nanoclaw/nc-templates` and `NC_TEMPLATES_DIR` points there
  (tsc does not copy them into `dist`). The layout script refuses to start without `guest.md` and `friend-persona.md`.
- Caddy serves `index.html` with `Cache-Control: no-cache` and without ETag/Last-Modified (nix-store files have
  mtime 1970); `/assets/*` stays immutable and a missing asset is a 404, not the SPA shell.

## BotFather checklist (manual, once per bot)

1. `/setmenubutton` is not needed: the host sets the chat menu button from `NC_MINIAPP_URL`.
2. Bot Settings -> Configure Mini App (Main Mini App): URL `https://<miniapp.domain>`; set the short name in `miniapp.shortName`.
3. Bot Settings -> enable guest queries (needed for guest mode / `guest` summons).
4. `/setdescription`, `/setabouttext` (ru), `/setuserpic`; `/setcommands` default scope empty if the bot should show no command list.
