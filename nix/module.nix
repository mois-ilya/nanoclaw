# NixOS module for the NanoClaw fork: host, nanogate, nanorelay images, agent
# image, Mini App vhost, STT, optional tailnet connector, backups and the
# host-firewall rules that keep the per-role Podman networks apart.
#
# See nix/README.md for the architecture and the consumer-side wiring.
{ self }:
{ config, lib, pkgs, ... }:

let
  inherit (lib) mkOption mkEnableOption mkIf mkMerge types optionalString optionals concatStringsSep escapeShellArg;

  cfg = config.services.nanoclaw;
  selfPkgs = self.packages.${pkgs.stdenv.hostPlatform.system};

  podman = config.virtualisation.podman.package;
  podmanSock = "/run/podman/podman.sock";
  expectedArch = if pkgs.stdenv.hostPlatform.isAarch64 then "arm64" else "amd64";

  agentRef = "localhost/${cfg.agentImage.imageRef}";
  relayRef = "localhost/${cfg.nanorelay.image.imageRef}";
  gateRef = "localhost/${cfg.nanogate.image.imageRef}";
  tsRef = "localhost/${cfg.tailscale.owner.image.imageRef}";

  gateStateDir = "/var/lib/nanogate";
  adminSocket = "/run/nanogate/admin.sock";
  tsStateDir = "/var/lib/nanoclaw-ts/owner";
  hostPackageDir = "${cfg.package}/lib/nanoclaw";

  # Identity of the code the host runs; replaces git for the upgrade tripwire
  # (NANOCLAW_BUILD_ID, see src/upgrade-state.ts).
  buildId = builtins.substring 0 32 (baseNameOf (toString cfg.package));
  hostVersion = cfg.package.version;
  tz = cfg.timeZone;

  nonSlice = name: lib.removeSuffix ".slice" name;

  # ---------------------------------------------------------------- firewall
  # Rules by role (v8 decision B1). Each rule is rendered for the iptables or
  # the nftables backend; "return"/"accept" means "no objection from this
  # chain", never a global accept.
  net = cfg.network;
  rfc1918 = [ "10.0.0.0/8" "172.16.0.0/12" "192.168.0.0/16" "100.64.0.0/10" "169.254.0.0/16" ];
  uplinkSubnets = [ net.egressSubnet ] ++ optionals cfg.tailscale.owner.enable [ net.connUplinkSubnet ];
  internalSubnets = [ net.svcSubnet ] ++ optionals cfg.tailscale.owner.enable [ net.connOwnerSubnet ];

  inputRules =
    [ { ct = true; verdict = "pass"; } ]
    # aardvark-dns answers on each bridge's gateway address.
    ++ map (s: { src = s; dst = s; proto = "udp"; dport = 53; verdict = "pass"; }) ([ net.sessionPool ] ++ internalSubnets ++ uplinkSubnets)
    ++ map (s: { src = s; dst = s; proto = "tcp"; dport = 53; verdict = "pass"; }) ([ net.sessionPool ] ++ internalSubnets ++ uplinkSubnets)
    ++ map (s: { src = s; verdict = "drop"; }) ([ net.sessionPool ] ++ internalSubnets ++ uplinkSubnets);

  forwardRules =
    [ { ct = true; verdict = "pass"; } ]
    # Session agents talk to their own bridge only.
    ++ [ { src = net.sessionPool; dstNot = net.sessionPool; verdict = "drop"; } ]
    # Nothing outside the pool reaches into sessions (AWG peers, other containers).
    ++ [ { srcNot = net.sessionPool; dst = net.sessionPool; verdict = "drop"; } ]
    # Internal service networks never route anywhere.
    ++ map (s: { src = s; dstNot = s; verdict = "drop"; }) internalSubnets
    # NAT'd uplinks reach the public internet only: no host, AWG, private ranges, other pools.
    ++ lib.concatMap (s:
      map (d: { src = s; dst = d; verdict = "drop"; })
        (cfg.firewall.hostAddresses ++ cfg.firewall.vpnSubnets ++ [ net.sessionPool net.servicePool ] ++ rfc1918))
      uplinkSubnets;

  renderIpt = r:
    concatStringsSep " " (
      optionals (r ? src) [ "-s" r.src ]
      ++ optionals (r ? srcNot) [ "!" "-s" r.srcNot ]
      ++ optionals (r ? dst) [ "-d" r.dst ]
      ++ optionals (r ? dstNot) [ "!" "-d" r.dstNot ]
      ++ optionals (r ? proto) [ "-p" r.proto "--dport" (toString r.dport) ]
      ++ optionals (r.ct or false) [ "-m" "conntrack" "--ctstate" "ESTABLISHED,RELATED" ]
      ++ [ "-j" (if r.verdict == "drop" then "DROP" else "RETURN") ]
    );

  renderNft = r:
    concatStringsSep " " (
      optionals (r ? src) [ "ip" "saddr" r.src ]
      ++ optionals (r ? srcNot) [ "ip" "saddr" "!=" r.srcNot ]
      ++ optionals (r ? dst) [ "ip" "daddr" r.dst ]
      ++ optionals (r ? dstNot) [ "ip" "daddr" "!=" r.dstNot ]
      ++ optionals (r ? proto) [ r.proto "dport" (toString r.dport) ]
      ++ optionals (r.ct or false) [ "ct" "state" "established,related" ]
      ++ [ (if r.verdict == "drop" then "drop" else "accept") ]
    );

  fwBackend =
    if cfg.firewall.backend == "auto"
    then (if config.networking.nftables.enable then "nftables" else "iptables")
    else cfg.firewall.backend;

  iptStart = ''
    # nanoclaw: dedicated chains, jumped to from the top of INPUT/FORWARD.
    # Idempotent (the NixOS firewall re-runs this on reload) and scoped to the
    # pools; no other chain is flushed or modified.
    for c in nanoclaw-in nanoclaw-fwd; do
      iptables -w -N "$c" 2>/dev/null || true
      iptables -w -F "$c"
    done
    while iptables -w -D INPUT -j nanoclaw-in 2>/dev/null; do :; done
    while iptables -w -D FORWARD -j nanoclaw-fwd 2>/dev/null; do :; done
    ${concatStringsSep "\n" (map (r: "iptables -w -A nanoclaw-in ${renderIpt r}") inputRules)}
    ${concatStringsSep "\n" (map (r: "iptables -w -A nanoclaw-fwd ${renderIpt r}") forwardRules)}
    iptables -w -I INPUT 1 -j nanoclaw-in
    iptables -w -I FORWARD 1 -j nanoclaw-fwd
  '';
  iptStop = ''
    while iptables -w -D INPUT -j nanoclaw-in 2>/dev/null; do :; done
    while iptables -w -D FORWARD -j nanoclaw-fwd 2>/dev/null; do :; done
    for c in nanoclaw-in nanoclaw-fwd; do
      iptables -w -F "$c" 2>/dev/null || true
      iptables -w -X "$c" 2>/dev/null || true
    done
  '';
  nftContent = ''
    chain input {
      type filter hook input priority -10; policy accept;
      ${concatStringsSep "\n      " (map renderNft inputRules)}
    }
    chain forward {
      type filter hook forward priority -10; policy accept;
      ${concatStringsSep "\n      " (map renderNft forwardRules)}
    }
  '';

  # ----------------------------------------------------------------- scripts
  mkScript = name: runtimeInputs: text: pkgs.writeShellApplication { inherit name runtimeInputs text; };

  imagesScript = mkScript "nanoclaw-load-images" [ podman pkgs.coreutils pkgs.gnugrep pkgs.findutils ] ''
    load() {
      local ref="$1" stream="$2" repo
      repo="''${ref%:*}"
      if ! podman image exists "$ref"; then
        echo "loading $ref"
        "$stream" | podman load
      fi
      local arch
      arch=$(podman image inspect --format '{{.Architecture}}' "$ref")
      if [ "$arch" != ${expectedArch} ]; then
        echo "image $ref has architecture $arch, expected ${expectedArch}" >&2
        exit 1
      fi
      # Older tags of the same repository are garbage once a new one is in; a
      # tag still used by a container just fails to remove and stays.
      podman image ls --format '{{.Repository}}:{{.Tag}}' | grep -F "$repo:" | grep -vxF "$ref" \
        | xargs -r podman rmi >/dev/null 2>&1 || true
    }
    ${concatStringsSep "\n" (map (i: "load ${escapeShellArg "localhost/${i.imageRef}"} ${i}") images)}
  '';

  networksScript = mkScript "nanoclaw-networks" [ podman pkgs.jq ] ''
    # ensure NAME SUBNET INTERNAL(true|false)
    ensure() {
      local name="$1" subnet="$2" internal="$3"
      if ! podman network exists "$name"; then
        if [ "$internal" = true ]; then
          podman network create --internal --subnet "$subnet" --label nanoclaw.role=service "$name" >/dev/null
        else
          podman network create --subnet "$subnet" --label nanoclaw.role=service "$name" >/dev/null
        fi
      fi
      local got
      got=$(podman network inspect "$name" | jq -r '.[0] | "\(.subnets[0].subnet) \(.internal)"')
      if [ "$got" != "$subnet $internal" ]; then
        echo "network $name is '$got', expected '$subnet $internal': refusing to run on a mismatched network" >&2
        exit 1
      fi
    }
    ensure nanogate-svc ${net.svcSubnet} true
    ensure nanogate-egress ${net.egressSubnet} false
    ${optionalString cfg.tailscale.owner.enable ''
      ensure conn-owner ${net.connOwnerSubnet} true
      ensure conn-uplink ${net.connUplinkSubnet} false
    ''}
  '';

  gateConfigBase = pkgs.writeText "nanogate-config-base.json" (builtins.toJSON {
    anthropicKeyFile = "/run/secrets/anthropic_api_key";
    encryptionKeyFile = "/run/secrets/nanogate_key";
    stateDir = gateStateDir;
    inherit (cfg.nanogate) denyCidrs hostAddresses;
    globalCapUsdMicros = cfg.nanogate.globalCapUsd * 1000000;
    # hostBind: the host-caller listener defaults to 127.0.0.1 inside the
    # container, which `-p 127.0.0.1:8090:8090` cannot reach through the
    # container's netns; bind 0.0.0.0 here, the host-side publish stays loopback.
    anthropicLimits.upstreamNonStreamTimeoutMs = cfg.nanogate.upstreamNonStreamTimeoutMs;
    listen = { bind = "0.0.0.0"; hostBind = "0.0.0.0"; anthropicPort = 8080; connectPort = 3128; hostPort = 8090; adminSocket = adminSocket; };
  });

  gatePrepare = mkScript "nanogate-prepare" [ pkgs.coreutils pkgs.jq pkgs.acl ] ''
    install -d -o 65532 -g 65532 -m 0750 ${gateStateDir}
    # /run/nanogate: only the container user and (via ACL, set after start)
    # the nanoclaw user may traverse it; the socket itself is 0600.
    install -d -o 65532 -g 65532 -m 0700 /run/nanogate
    install -d -m 0755 /run/nanogate-config
    install -d -o 65532 -g 65532 -m 0500 /run/nanogate-secrets
    install -o 65532 -g 65532 -m 0400 "$CREDENTIALS_DIRECTORY/anthropic-key" /run/nanogate-secrets/anthropic_api_key
    install -o 65532 -g 65532 -m 0400 "$CREDENTIALS_DIRECTORY/nanogate-key" /run/nanogate-secrets/nanogate_key
    jq -s '.[0] + { prices: .[1] }' ${gateConfigBase} "$CREDENTIALS_DIRECTORY/prices" > /run/nanogate-config/config.json
    chmod 0444 /run/nanogate-config/config.json
  '';

  gateStart = mkScript "nanogate-start" [ podman ] ''
    exec podman run --rm --replace --name nanogate --hostname nanogate \
      --network nanogate-svc:alias=nanogate --network nanogate-egress ${optionalString cfg.tailscale.owner.enable "--network conn-owner"} \
      --user 65532:65532 --read-only --tmpfs /tmp:rw,size=16m,mode=1777 \
      --cap-drop=ALL --security-opt no-new-privileges \
      --memory 512m --pids-limit 256 --stop-timeout 20 \
      -v ${gateStateDir}:${gateStateDir} -v /run/nanogate:/run/nanogate \
      -v /run/nanogate-secrets:/run/secrets:ro -v /run/nanogate-config:/etc/nanogate:ro \
      -e NANOGATE_CONFIG=/etc/nanogate/config.json \
      -p 127.0.0.1:8090:8090 \
      ${gateRef}
  '';

  gateAfterStart = mkScript "nanogate-acl" [ pkgs.acl pkgs.coreutils ] ''
    for _ in $(seq 1 120); do
      [ -S ${adminSocket} ] && break
      sleep 0.5
    done
    [ -S ${adminSocket} ] || { echo "nanogate admin socket did not appear" >&2; exit 1; }
    setfacl -m u:nanoclaw:x /run/nanogate
    setfacl -m u:nanoclaw:rw ${adminSocket}
  '';

  layoutScript = mkScript "nanoclaw-layout" [ pkgs.coreutils pkgs.findutils ] ''
    cd ${cfg.stateDir}
    install -d -o nanoclaw -g nanoclaw -m 0750 data store groups logs
    pkg=${hostPackageDir}

    ${if cfg.layout == "symlink" then ''
      # Immutable surfaces: links straight into the store. Mount admission
      # checks the path lexically (src/drivers/types.ts), the runtime follows
      # the link when binding.
      for item in package.json dist node_modules container templates; do
        ln -sfn "$pkg/$item" "$item"
      done
    '' else ''
      # Copy mode: a release copy under the state dir, one real directory per
      # build; links point there. Keeps bind-mount sources off the store.
      rel=${cfg.stateDir}/release/${buildId}
      if [ ! -d "$rel" ]; then
        mkdir -p "$rel.tmp"
        cp -r --no-preserve=mode,ownership "$pkg/container" "$pkg/templates" "$rel.tmp/"
        chown -R nanoclaw:nanoclaw "$rel.tmp"
        mv "$rel.tmp" "$rel"
      fi
      for item in package.json dist node_modules; do ln -sfn "$pkg/$item" "$item"; done
      for item in container templates; do ln -sfn "$rel/$item" "$item"; done
      # keep the two newest releases
      # shellcheck disable=SC2012
      ls -1dt ${cfg.stateDir}/release/*/ | tail -n +3 | xargs -r rm -rf
    ''}

    # Asset manifest: the host reads these from its working directory. A
    # missing one must stop the start here, not fail later inside a session.
    missing=0
    for f in package.json dist/index.js node_modules container/CLAUDE.md \
             container/agent-runner/src/index.ts container/skills templates \
             "$pkg/nc-templates/guest.md" "$pkg/nc-templates/friend-persona.md"; do
      if [ ! -e "$f" ]; then echo "asset manifest: missing $f" >&2; missing=1; fi
    done
    [ "$missing" = 0 ]
    chown -h nanoclaw:nanoclaw package.json dist node_modules container templates
  '';

  backupScript = mkScript "nanoclaw-backup" [ pkgs.coreutils pkgs.findutils pkgs.sqlite pkgs.gnutar pkgs.zstd pkgs.gnugrep ] ''
    # usage: nanoclaw-backup [label]
    label="''${1:-nightly}"
    dest=${cfg.backup.dir}/$(date -u +%Y%m%dT%H%M%SZ)-$label
    install -d -m 0700 ${cfg.backup.dir}
    # Make room first (a full disk would otherwise fail every retry), and never leave a partial snapshot behind.
    # shellcheck disable=SC2012
    ls -1d ${cfg.backup.dir}/*/ 2>/dev/null | sort -r | tail -n +${toString cfg.backup.keep} | xargs -r rm -rf
    mkdir -p "$dest"
    ok=0
    trap '[ "$ok" = 1 ] || rm -rf "$dest"' EXIT

    snap() { # SRC DST: online SQLite .backup, skipped when the source is absent
      [ -f "$1" ] || return 0
      mkdir -p "$(dirname "$2")"
      sqlite3 "$1" ".timeout 10000" ".backup '$2'"
    }
    snap ${cfg.stateDir}/data/v2.db "$dest/nanoclaw/v2.db"
    snap ${gateStateDir}/nanogate.db "$dest/nanogate/nanogate.db"
    if [ -d ${cfg.stateDir}/data/v2-sessions ]; then
      while IFS= read -r db; do
        rel="''${db#${cfg.stateDir}/data/v2-sessions/}"
        snap "$db" "$dest/sessions/$rel" || echo "skip $db" >&2
      done < <(find ${cfg.stateDir}/data/v2-sessions -type f -name '*.db')
    fi
    if [ -d ${cfg.stateDir}/groups ]; then
      tar --zstd -C ${cfg.stateDir} -cf "$dest/groups.tar.zst" groups
    fi
    ok=1
    echo "backup written: $dest"
  '';

  # Snapshot before the first start of a new build, then stamp the marker the
  # upgrade tripwire compares ({version, buildId}).
  upgradeScript = mkScript "nanoclaw-upgrade-prestart" [ pkgs.coreutils pkgs.jq backupScript ] ''
    marker=${cfg.stateDir}/data/upgrade-state.json
    current=""
    if [ -f "$marker" ]; then current=$(jq -r '.buildId // ""' "$marker" 2>/dev/null || true); fi
    if [ "$current" = ${buildId} ]; then exit 0; fi
    if [ -f ${cfg.stateDir}/data/v2.db ]; then
      nanoclaw-backup pre-upgrade-${hostVersion}
    fi
    install -d -o nanoclaw -g nanoclaw -m 0750 ${cfg.stateDir}/data
    jq -n --arg v ${hostVersion} --arg b ${buildId} --arg t "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" \
      '{version: $v, commit: "unknown", tree: "unknown", buildId: $b, updatedAt: $t, via: "nix"}' > "$marker"
    chown nanoclaw:nanoclaw "$marker"
  '';

  images = [ cfg.agentImage cfg.nanorelay.image cfg.nanogate.image ]
    ++ optionals cfg.tailscale.owner.enable [ cfg.tailscale.owner.image ];

  hostEnv = {
    NANOCLAW_INSTALL_ID = cfg.installId;
    NANOCLAW_BUILD_ID = buildId;
    NANOCLAW_RUNTIME_DRIVER = "podman";
    NANOCLAW_GATEWAY_PROVIDER = "nanogate";
    NANOCLAW_PODMAN_URL = "unix://${podmanSock}";
    NANOCLAW_CONTAINER_RUNTIME_BIN = "podman";
    NANOCLAW_CONTAINER_RUNTIME_ARGS = "--remote --url unix://${podmanSock}";
    NANOCLAW_STRICT_ASSETS = "1";
    NANOCLAW_LOG_CONTENT = "0";
    NANOCLAW_OWNER_TELEGRAM_ID = toString cfg.ownerTelegramId;
    NANOGATE_ADMIN_SOCKET = adminSocket;
    NANORELAY_IMAGE = relayRef;
    NANOCLAW_SESSION_POOL = net.sessionPool;
    NANOCLAW_AUX_UPLINK_NETWORK = "nanogate-svc";
    NANOCLAW_CGROUP_PARENT = "nanoclaw.slice";
    NC_SLICE_PATH = "/sys/fs/cgroup/nanoclaw.slice";
    CONTAINER_IMAGE = agentRef;
    CONTAINER_IMAGE_BASE = "localhost/${cfg.agentImage.imageName}";
    CONTAINER_MEMORY_LIMIT = cfg.resources.agentMemory;
    CONTAINER_CPU_LIMIT = cfg.resources.agentCpus;
    CONTAINER_SHM_MB = toString cfg.resources.shmMb;
    CONTAINER_TMP_MB = toString cfg.resources.tmpMb;
    NC_MAX_CONTAINERS = toString cfg.resources.maxConcurrent;
    NC_IDLE_OWNER_MINUTES = toString cfg.idle.ownerMinutes;
    NC_IDLE_FRIEND_MINUTES = toString cfg.idle.friendMinutes;
    NC_INBOX_RETENTION_DAYS = toString cfg.inbox.retentionDays;
    NC_INBOX_QUOTA_MB = toString cfg.inbox.quotaMb;
    NC_GLOBAL_CAP_USD = toString cfg.nanogate.globalCapUsd;
    NC_NANOGATE_HOST_URL = "http://127.0.0.1:8090";
    WEBHOOK_PORT = toString cfg.webhookPort;
    TZ = tz;
    NC_DEFAULT_TZ = tz;
    NC_TEMPLATES_DIR = "${hostPackageDir}/nc-templates";
  }
  // lib.optionalAttrs cfg.stt.enable { NC_STT_URL = "http://127.0.0.1:${toString cfg.stt.port}"; }
  // lib.optionalAttrs cfg.stopButton { NC_STOP_ENABLED = "1"; }
  // lib.optionalAttrs (cfg.botName != null) { NC_BOT_NAME = cfg.botName; }
  // lib.optionalAttrs (cfg.ownerName != null) { NC_OWNER_NAME = cfg.ownerName; }
  // lib.optionalAttrs (cfg.ownerNameGen != null) { NC_OWNER_NAME_GEN = cfg.ownerNameGen; }
  // lib.optionalAttrs (cfg.models.fast != null) { NC_MODEL_FAST = cfg.models.fast; }
  // lib.optionalAttrs (cfg.models.normal != null) { NC_MODEL_NORMAL = cfg.models.normal; }
  // lib.optionalAttrs (cfg.models.deep != null) { NC_MODEL_DEEP = cfg.models.deep; }
  // lib.optionalAttrs (cfg.models.guest != null) { NC_MODEL_GUEST = cfg.models.guest; }
  // lib.optionalAttrs (cfg.models.small != null) { NC_MODEL_SMALL = cfg.models.small; }
  // lib.optionalAttrs cfg.miniapp.enable {
    NC_MINIAPP_PORT = toString cfg.miniapp.apiPort;
    NC_MINIAPP_URL = "https://${cfg.miniapp.domain}";
    NC_MINIAPP_STATIC_DIR = toString cfg.miniapp.package;
  }
  // lib.optionalAttrs (cfg.alertCommand != null) { NC_ALERT_COMMAND = cfg.alertCommand; }
  // lib.optionalAttrs (cfg.miniapp.shortName != null) { NC_MINIAPP_SHORTNAME = cfg.miniapp.shortName; }
  // lib.optionalAttrs cfg.tailscale.owner.enable {
    NC_OWNER_CONNECTOR_SOCKS = "nanoclaw-ts-owner:1055";
    NC_OWNER_TAILNET_CIDRS = concatStringsSep "," cfg.tailscale.owner.tailnetCidrs;
    NC_OWNER_TAILNET_ALLOW = concatStringsSep "," cfg.tailscale.owner.tailnetAllow;
    # set-but-empty means «no exit node» for the host (src/nc/connector.ts)
    NC_OWNER_EXIT_NODE = if cfg.tailscale.owner.exitNode == null then "" else cfg.tailscale.owner.exitNode;
  }
  // cfg.extraEnv;

  hardening = {
    NoNewPrivileges = true;
    ProtectSystem = "strict";
    ProtectHome = true;
    PrivateTmp = true;
    ProtectKernelTunables = true;
    ProtectKernelModules = true;
    ProtectControlGroups = true;
    ProtectClock = true;
    ProtectHostname = true;
    LockPersonality = true;
    RestrictSUIDSGID = true;
    RestrictRealtime = true;
    RestrictNamespaces = true;
    SystemCallArchitectures = "native";
    RestrictAddressFamilies = [ "AF_UNIX" "AF_INET" "AF_INET6" ];
  };
in
{
  options.services.nanoclaw = {
    enable = mkEnableOption "NanoClaw (host, nanogate, per-session Podman agents)";

    package = mkOption {
      type = types.package;
      default = selfPkgs.nanoclaw-host;
      defaultText = "nanoclaw.packages.<system>.nanoclaw-host";
      description = "Host package (Node app, node_modules, container assets).";
    };
    agentImage = mkOption {
      type = types.package;
      default = selfPkgs.nanoclaw-agent-image;
      defaultText = "nanoclaw.packages.<system>.nanoclaw-agent-image";
      description = "Streamed OCI image for agent containers (needs passthru imageRef/imageName).";
    };

    stateDir = mkOption {
      type = types.path;
      default = "/var/lib/nanoclaw";
      description = "Working directory and mutable state (data/, store/, groups/, logs/). Keep it stable: the install slug derives from it unless installId is set.";
    };
    layout = mkOption {
      type = types.enum [ "symlink" "copy" ];
      default = "symlink";
      description = ''
        How container/ and templates/ reach the state dir. "symlink" links into
        the Nix store; "copy" materialises a release copy under
        stateDir/release/<build> (use it if bind-mount admission or the runtime
        rejects store-backed sources).
      '';
    };
    installId = mkOption {
      type = types.str;
      example = "nuremberg-prod";
      description = "Explicit NANOCLAW_INSTALL_ID; labels every runtime object this install owns.";
    };
    ownerTelegramId = mkOption {
      type = types.ints.positive;
      description = "Numeric Telegram user id of the owner.";
    };
    webhookPort = mkOption {
      type = types.port;
      default = 13000;
      description = "Upstream's webhook listener binds regardless of the Telegram adapter's polling mode; keep it off ports already in use.";
    };

    telegram.tokenFile = mkOption {
      type = types.path;
      description = "File with the Telegram bot token (delivered through systemd LoadCredential).";
    };
    anthropicKeyFile = mkOption {
      type = types.path;
      description = "File with the Anthropic API key. Readable only to nanogate (copied into its private secrets dir at start).";
    };

    nanogate = {
      package = mkOption { type = types.package; default = selfPkgs.nanogate; defaultText = "nanoclaw.packages.<system>.nanogate"; };
      image = mkOption { type = types.package; default = selfPkgs.nanogate-image; defaultText = "nanoclaw.packages.<system>.nanogate-image"; };
      encryptionKeyFile = mkOption { type = types.path; description = "32 random bytes (hex or base64) for AES-256-GCM of stored tokens and secrets."; };
      pricesFile = mkOption {
        type = types.path;
        default = ./default-prices.json;
        defaultText = "nix/default-prices.json (UNVERIFIED placeholder values)";
        description = ''
          JSON file with the price table (`{version, models, serverTools}`): USD per million tokens for models,
          USD per use for server tools. The default file covers claude-haiku-5-5, claude-sonnet-5-5, claude-opus-5-5
          and the server tools of the default policy (web_search, web_fetch), but its numbers are placeholders:
          verify them against anthropic.com/pricing and override this option. Every model named in `models.*`
          must be priced here, otherwise its requests cost 0 in the budget.
        '';
      };
      globalCapUsd = mkOption { type = types.ints.unsigned; default = 100; description = "Monthly cap across all tenants, USD."; };
      denyCidrs = mkOption {
        type = types.listOf types.str;
        default = [ "10.201.0.0/20" ];
        description = "Extra CIDRs the CONNECT proxy never dials (on top of the built-in private/reserved set). Put the VPN subnet here.";
      };
      upstreamNonStreamTimeoutMs = mkOption { type = types.ints.positive; default = 600000; description = "anthropicLimits.upstreamNonStreamTimeoutMs: whole-response deadline for non-streaming upstream requests."; };
      hostAddresses = mkOption {
        type = types.listOf types.str;
        default = [ ];
        description = "Public/other addresses of this host, denied for CONNECT.";
      };
    };

    nanorelay.image = mkOption { type = types.package; default = selfPkgs.nanorelay-image; defaultText = "nanoclaw.packages.<system>.nanorelay-image"; };

    network = {
      sessionPool = mkOption { type = types.str; default = "10.90.0.0/16"; description = "Pool of per-session internal networks (/28 each)."; };
      servicePool = mkOption { type = types.str; default = "10.91.0.0/16"; description = "Pool for the fixed service networks."; };
      svcSubnet = mkOption { type = types.str; default = "10.91.0.0/24"; description = "nanogate-svc (internal): relays <-> nanogate."; };
      egressSubnet = mkOption { type = types.str; default = "10.91.1.0/24"; description = "nanogate-egress (NAT bridge): nanogate -> internet."; };
      connOwnerSubnet = mkOption { type = types.str; default = "10.91.2.0/24"; description = "conn-owner (internal): nanogate <-> owner tailnet connector."; };
      connUplinkSubnet = mkOption { type = types.str; default = "10.91.3.0/24"; description = "conn-uplink (NAT bridge): connector -> tailnet control/DERP."; };
    };

    firewall = {
      backend = mkOption {
        type = types.enum [ "auto" "iptables" "nftables" "none" ];
        default = "auto";
        description = ''
          Which host firewall carries the per-role rules. "auto" follows
          networking.nftables.enable. iptables: dedicated chains nanoclaw-in /
          nanoclaw-fwd via networking.firewall.extraCommands. nftables: a
          separate table `inet nanoclaw`. Either way only the pools are touched.
        '';
      };
      hostAddresses = mkOption {
        type = types.listOf types.str;
        default = config.services.nanoclaw.nanogate.hostAddresses;
        defaultText = "services.nanoclaw.nanogate.hostAddresses";
        description = "Host addresses the NAT'd uplink networks must not reach.";
      };
      vpnSubnets = mkOption {
        type = types.listOf types.str;
        default = config.services.nanoclaw.nanogate.denyCidrs;
        defaultText = "services.nanoclaw.nanogate.denyCidrs";
        description = "VPN/other internal subnets the NAT'd uplink networks must not reach.";
      };
    };

    resources = {
      sliceMemoryMax = mkOption { type = types.str; default = "4G"; };
      sliceMemoryHigh = mkOption { type = types.str; default = "3500M"; };
      agentMemory = mkOption { type = types.str; default = "1536m"; description = "CONTAINER_MEMORY_LIMIT per agent."; };
      agentCpus = mkOption { type = types.str; default = "2"; description = "CONTAINER_CPU_LIMIT per agent."; };
      shmMb = mkOption { type = types.ints.positive; default = 256; };
      tmpMb = mkOption { type = types.ints.positive; default = 512; };
      maxConcurrent = mkOption { type = types.ints.positive; default = 2; description = ''
        NC_MAX_CONTAINERS: global cap on running agent containers (src/spawn-admission.ts). Warm idle containers count
        against it; over the cap a wake waits (owner first) and the host stops an idle container to free a slot.
      ''; };
    };

    timeZone = mkOption {
      type = types.str;
      # Deliberately not config.time.timeZone: servers usually run UTC, but this is
      # the users' local time (reminders, digests, budget periods).
      default = "Europe/Moscow";
      description = "Users' default time zone: NC_DEFAULT_TZ (tenant default, task schedules, digest, nanogate budget period) and the host TZ.";
    };
    stopButton = mkOption { type = types.bool; default = true; description = "Native Stop button on drafts (NC_STOP_ENABLED=1)."; };
    botName = mkOption { type = types.nullOr types.str; default = null; description = "Assistant name in copy and container config (NC_BOT_NAME); the code default is «ассистент»."; };
    ownerName = mkOption { type = types.nullOr types.str; default = null; description = "Owner name, nominative (NC_OWNER_NAME)."; };
    ownerNameGen = mkOption { type = types.nullOr types.str; default = null; description = "Owner name, genitive (NC_OWNER_NAME_GEN)."; };
    models = lib.genAttrs [ "fast" "normal" "deep" "guest" "small" ] (preset: mkOption {
      type = types.nullOr types.str;
      default = null;
      description = "Model for the ${preset} preset (NC_MODEL_${lib.toUpper preset}); must be priced in nanogate.pricesFile. Unset keeps the code default.";
    });

    idle = {
      ownerMinutes = mkOption { type = types.ints.positive; default = 30; };
      friendMinutes = mkOption { type = types.ints.positive; default = 10; };
    };

    inbox = {
      retentionDays = mkOption { type = types.ints.unsigned; default = 30; description = "NC_INBOX_RETENTION_DAYS: delete received attachments older than this (0 = keep)."; };
      quotaMb = mkOption { type = types.ints.unsigned; default = 500; description = "NC_INBOX_QUOTA_MB: per-tenant inbox cap, oldest first (0 = no cap)."; };
    };

    miniapp = {
      enable = mkEnableOption "the Mini App Caddy vhost";
      package = mkOption { type = types.package; default = selfPkgs.nanoclaw-miniapp; defaultText = "nanoclaw.packages.<system>.nanoclaw-miniapp"; };
      domain = mkOption { type = types.str; example = "claw.example.com"; };
      apiPort = mkOption { type = types.port; default = 8095; description = "Host's Mini App API listener (NC_MINIAPP_PORT); proxied for /api/*."; };
      shortName = mkOption { type = types.nullOr types.str; default = null; description = ''
        BotFather Mini App short name (NC_MINIAPP_SHORTNAME), the one set under Bot Settings -> Configure Mini App.
        With it the bot builds t.me/<bot>/<shortName> links that work in groups and channels too. Without it the
        adapter falls back to native web_app buttons, which Telegram allows in private chats only (the module warns).
      ''; };
    };

    stt = {
      enable = mkOption { type = types.bool; default = true; description = "Local speech-to-text (whisper.cpp server); voice input is on for everyone by default (NC_STT_URL)."; };
      package = mkOption { type = types.package; default = pkgs.whisper-cpp; defaultText = "pkgs.whisper-cpp"; };
      model = mkOption {
        type = types.either (types.enum [ "small" "large-v3-turbo-q5_0" ]) types.path;
        default = "small";
        description = "A pinned model name from this flake, or a path to any ggml model file.";
      };
      port = mkOption { type = types.port; default = 8091; };
      threads = mkOption { type = types.ints.positive; default = 2; };
      memoryMax = mkOption { type = types.str; default = "1G"; };
    };

    tailscale.owner = {
      enable = mkEnableOption "the owner's tailnet connector (userspace tailscale, SOCKS5, optional residential exit node)";
      image = mkOption { type = types.package; default = selfPkgs.nanoclaw-tailscale-image; defaultText = "nanoclaw.packages.<system>.nanoclaw-tailscale-image"; };
      authKeyFile = mkOption { type = types.path; description = "Tailscale auth key (reusable, ephemeral recommended)."; };
      exitNode = mkOption {
        type = types.nullOr types.str;
        default = "gl-mt3000-beryl";
        description = "Exit node of the owner's connector (TS_EXIT_NODE and NC_OWNER_EXIT_NODE): the home router, so the owner's agent leaves from a residential IP. A stable node id is preferable to a name. null = no exit node (the host then tells the owner there is none).";
      };
      tailnetCidrs = mkOption { type = types.listOf types.str; default = [ ]; description = "Tailnet/subnet CIDRs the owner's agents may reach (NC_OWNER_TAILNET_CIDRS)."; };
      tailnetAllow = mkOption {
        type = types.listOf types.str;
        default = [ ];
        example = [ "192.168.8.1:80" "192.168.8.0/24:8123" "*.ts.net:443" ];
        description = "Allowlist of tailnet / home-LAN destinations the owner's agent may open (NC_OWNER_TAILNET_ALLOW; entries `host:port`, `cidr:port`, `*.ts.net:port`). Empty keeps tailnet access off even when the connector is up.";
      };
    };

    backup = {
      enable = mkOption { type = types.bool; default = true; description = "Nightly backups (pre-upgrade snapshots are taken regardless)."; };
      dir = mkOption { type = types.path; default = "/var/backups/nanoclaw"; };
      keep = mkOption { type = types.ints.positive; default = 14; };
    };

    alertCommand = mkOption {
      type = types.nullOr types.str;
      default = null;
      example = "/run/current-system/sw/bin/pulse-notify";
      description = "Executable that receives every owner alert as its single argument, in addition to the Telegram message (NC_ALERT_COMMAND, 10 s timeout). Must be reachable from nanoclaw.service's sandbox. Unset = Telegram only.";
    };

    extraEnv = mkOption {
      type = types.attrsOf types.str;
      default = { };
      description = "Extra environment for nanoclaw.service (overrides module-set values).";
    };
  };

  config = mkIf cfg.enable (mkMerge [
    {
      warnings = optionals (cfg.miniapp.enable && cfg.miniapp.shortName == null) [
        "services.nanoclaw.miniapp.shortName is unset: the bot falls back to native web_app buttons (private chats only). Set the short name from BotFather -> Configure Mini App."
      ];

      assertions = [
        { assertion = config.virtualisation.podman.enable; message = "services.nanoclaw needs virtualisation.podman.enable = true."; }
        {
          assertion = (config.virtualisation.containers.containersConf.settings.network.firewall_driver or "") != "none";
          message = ''
            services.nanoclaw: netavark's firewall_driver = "none" removes the isolation
            rules of --internal networks. Use the default (nftables) driver.
          '';
        }
        {
          assertion = cfg.firewall.backend == "none" || fwBackend == "nftables" || config.networking.firewall.enable;
          message = "services.nanoclaw: the iptables rule backend needs networking.firewall.enable = true.";
        }
      ];

      users.groups.podman = { };
      users.groups.nanoclaw = { };
      users.users.nanoclaw = {
        isSystemUser = true;
        group = "nanoclaw";
        extraGroups = [ "podman" ]; # root-equivalent: the rootful podman socket
        home = cfg.stateDir;
        description = "NanoClaw host";
      };

      systemd.tmpfiles.rules = [
        "d ${cfg.stateDir} 0750 nanoclaw nanoclaw -"
        "d ${cfg.backup.dir} 0700 root root -"
      ];

      # Rootful podman API, reachable by the podman group only.
      systemd.sockets.podman.socketConfig = {
        SocketGroup = "podman";
        SocketMode = "0660";
      };

      systemd.slices.nanoclaw = {
        description = "NanoClaw host, agents and STT";
        sliceConfig = {
          MemoryHigh = cfg.resources.sliceMemoryHigh;
          MemoryMax = cfg.resources.sliceMemoryMax;
          MemorySwapMax = "0";
        };
      };

      systemd.services.nanoclaw-images = {
        description = "Load NanoClaw OCI images into Podman";
        wantedBy = [ "multi-user.target" ];
        after = [ "podman.socket" ];
        before = [ "nanoclaw-networks.service" "nanogate.service" "nanoclaw.service" ];
        serviceConfig = {
          Type = "oneshot";
          RemainAfterExit = true;
          ExecStart = "${imagesScript}/bin/nanoclaw-load-images";
          TimeoutStartSec = "30min";
        };
      };

      systemd.services.nanoclaw-networks = {
        description = "NanoClaw Podman service networks";
        wantedBy = [ "multi-user.target" ];
        after = [ "podman.socket" "nanoclaw-images.service" ];
        before = [ "nanogate.service" "nanoclaw.service" ];
        serviceConfig = {
          Type = "oneshot";
          RemainAfterExit = true;
          ExecStart = "${networksScript}/bin/nanoclaw-networks";
        };
      };

      systemd.services.nanogate = {
        description = "NanoClaw gateway (Anthropic key holder, budget, egress proxy)";
        wantedBy = [ "multi-user.target" ];
        wants = [ "network-online.target" ];
        after = [ "network-online.target" "nanoclaw-images.service" "nanoclaw-networks.service" ];
        requires = [ "nanoclaw-images.service" "nanoclaw-networks.service" ];
        serviceConfig = {
          Type = "simple";
          LoadCredential = [
            "anthropic-key:${cfg.anthropicKeyFile}"
            "nanogate-key:${cfg.nanogate.encryptionKeyFile}"
            "prices:${cfg.nanogate.pricesFile}"
          ];
          RuntimeDirectory = [ "nanogate" "nanogate-secrets" "nanogate-config" ];
          RuntimeDirectoryPreserve = "no";
          ExecStartPre = "+${gatePrepare}/bin/nanogate-prepare";
          ExecStart = "${gateStart}/bin/nanogate-start";
          ExecStartPost = "+${gateAfterStart}/bin/nanogate-acl";
          ExecReload = "${podman}/bin/podman kill --signal HUP nanogate";
          Restart = "on-failure";
          RestartSec = 3;
          KillMode = "mixed";
          TimeoutStopSec = 40;
        };
      };

      systemd.services.nanoclaw = {
        description = "NanoClaw host";
        wantedBy = [ "multi-user.target" ];
        wants = [ "network-online.target" ];
        after = [ "network-online.target" "podman.socket" "nanoclaw-images.service" "nanoclaw-networks.service" "nanogate.service" ];
        requires = [ "podman.socket" "nanoclaw-images.service" "nanoclaw-networks.service" "nanogate.service" ];
        path = [ podman pkgs.coreutils ];
        environment = hostEnv;
        serviceConfig = hardening // {
          User = "nanoclaw";
          Group = "nanoclaw";
          SupplementaryGroups = [ "podman" ];
          Slice = "nanoclaw.slice";
          WorkingDirectory = cfg.stateDir;
          LoadCredential = [ "telegram-token:${cfg.telegram.tokenFile}" ];
          # %d: the credentials directory (not escaped, unlike `environment`).
          Environment = [ "TELEGRAM_BOT_TOKEN_FILE=%d/telegram-token" ];
          ExecStartPre = [
            "+${layoutScript}/bin/nanoclaw-layout"
            "+${upgradeScript}/bin/nanoclaw-upgrade-prestart"
          ];
          ExecStart = "${cfg.package}/bin/nanoclaw-host";
          ReadWritePaths = [ cfg.stateDir ];
          Restart = "on-failure";
          RestartSec = 5;
          # The pre-upgrade snapshot (tar of groups/, SQLite .backup of every DB) runs in ExecStartPre; the default
          # 90 s would kill it on a large groups/ and loop. A failed snapshot still blocks the start on purpose.
          TimeoutStartSec = "30min";
          # Under slice memory pressure the kernel OOM killer must pick an agent or whisper, not the host.
          OOMScoreAdjust = -500;
          TimeoutStopSec = 60;
          UMask = "0027";
        };
      };

      # Operator CLI as the nanoclaw user, from anywhere: `sudo -u nanoclaw ncl ...`
      environment.systemPackages = [
        (pkgs.writeShellScriptBin "nanoclaw-ncl" ''
          cd ${cfg.stateDir}
          exec env ${lib.concatStringsSep " " (lib.mapAttrsToList (k: v: "${k}=${escapeShellArg v}") (lib.filterAttrs (k: _: builtins.elem k [ "NANOCLAW_INSTALL_ID" "NANOCLAW_BUILD_ID" ]) hostEnv))} ${cfg.package}/bin/ncl "$@"
        '')
        backupScript
      ];
    }

    (mkIf cfg.backup.enable {
      systemd.services.nanoclaw-backup = {
        description = "NanoClaw nightly backup (SQLite .backup + groups/)";
        serviceConfig = {
          Type = "oneshot";
          ExecStart = "${backupScript}/bin/nanoclaw-backup nightly";
          Nice = 10;
          IOSchedulingClass = "idle";
        };
      };
      systemd.timers.nanoclaw-backup = {
        wantedBy = [ "timers.target" ];
        timerConfig = { OnCalendar = "*-*-* 03:30:00"; RandomizedDelaySec = "20min"; Persistent = true; };
      };
    })

    (mkIf (cfg.firewall.backend != "none" && fwBackend == "iptables") {
      networking.firewall.extraCommands = iptStart;
      networking.firewall.extraStopCommands = iptStop;
    })
    (mkIf (cfg.firewall.backend != "none" && fwBackend == "nftables") {
      networking.nftables.tables.nanoclaw = { family = "inet"; content = nftContent; };
    })

    (mkIf cfg.miniapp.enable {
      services.caddy.virtualHosts.${cfg.miniapp.domain}.extraConfig = ''
        encode zstd gzip
        header {
          Strict-Transport-Security "max-age=31536000; includeSubDomains"
          X-Content-Type-Options nosniff
          Referrer-Policy no-referrer
          Permissions-Policy "camera=(), microphone=(), geolocation=(), interest-cohort=()"
          Content-Security-Policy "frame-ancestors https://web.telegram.org https://*.telegram.org https://web.telegram.org.* 'self'"
          -Server
        }
        handle /api/* {
          reverse_proxy 127.0.0.1:${toString cfg.miniapp.apiPort}
        }
        handle {
          root * ${cfg.miniapp.package}
          @assets path /assets/*
          header @assets Cache-Control "public, max-age=31536000, immutable"
          # index.html (and any SPA fallback) must revalidate after a redeploy:
          # store files have mtime 1970, so heuristic caching would keep a stale shell.
          @html not path /assets/*
          header @html Cache-Control "no-cache"
          header @html -ETag
          header @html -Last-Modified
          # SPA fallback for routes only; a missing /assets/* file is a 404, not HTML
          # (try_files takes no matcher, hence the separate route).
          route @html {
            try_files {path} /index.html
          }
          file_server
        }
      '';
    })

    (mkIf cfg.stt.enable (
      let
        model = if builtins.isString cfg.stt.model && builtins.elem cfg.stt.model [ "small" "large-v3-turbo-q5_0" ]
          then self.packages.${pkgs.stdenv.hostPlatform.system}."whisper-model-${cfg.stt.model}"
          else cfg.stt.model;
      in
      {
        systemd.services.nanoclaw-stt = {
          description = "NanoClaw speech-to-text (whisper.cpp server, loopback only)";
          wantedBy = [ "multi-user.target" ];
          after = [ "network.target" ];
          path = [ pkgs.ffmpeg-headless ];
          serviceConfig = hardening // {
            DynamicUser = true;
            Slice = "nanoclaw.slice";
            # --convert decodes OGG/Opus via ffmpeg and writes the upload to
            # --tmp-dir (default "."): the unit's cwd is "/", read-only.
            ExecStart = "${cfg.stt.package}/bin/whisper-server --host 127.0.0.1 --port ${toString cfg.stt.port} -m ${model} -t ${toString cfg.stt.threads} --convert --tmp-dir /tmp";
            IPAddressAllow = "localhost";
            IPAddressDeny = "any";
            MemoryMax = cfg.stt.memoryMax;
            PrivateNetwork = false;
            Restart = "on-failure";
            RestartSec = 5;
          };
        };
      }
    ))

    (mkIf cfg.tailscale.owner.enable {
      systemd.services.nanoclaw-ts-owner = {
        description = "NanoClaw owner tailnet connector";
        wantedBy = [ "multi-user.target" ];
        after = [ "nanogate.service" "nanoclaw-networks.service" "nanoclaw-images.service" "network-online.target" ];
        requires = [ "nanoclaw-networks.service" "nanoclaw-images.service" ];
        wants = [ "network-online.target" ];
        serviceConfig = {
          Type = "simple";
          LoadCredential = [ "authkey:${cfg.tailscale.owner.authKeyFile}" ];
          RuntimeDirectory = "nanoclaw-ts-owner-secrets";
          ExecStartPre = "+${pkgs.writeShellScript "nanoclaw-ts-owner-prepare" ''
            ${pkgs.coreutils}/bin/install -d -o 65532 -g 65532 -m 0700 ${tsStateDir}
            ${pkgs.coreutils}/bin/install -o 65532 -g 65532 -m 0400 "$CREDENTIALS_DIRECTORY/authkey" /run/nanoclaw-ts-owner-secrets/authkey
            ${pkgs.coreutils}/bin/chown 65532:65532 /run/nanoclaw-ts-owner-secrets
          ''}";
          ExecStart = "${pkgs.writeShellScript "nanoclaw-ts-owner-start" ''
            exec ${podman}/bin/podman run --rm --replace --name nanoclaw-ts-owner --hostname nanoclaw-owner \
              --network conn-owner:alias=nanoclaw-ts-owner --network conn-uplink \
              --user 65532:65532 --cap-drop=ALL --security-opt no-new-privileges \
              --read-only --tmpfs /tmp:rw,size=64m,mode=1777 \
              --memory 256m --pids-limit 256 --stop-timeout 15 \
              -v ${tsStateDir}:/state -v /run/nanoclaw-ts-owner-secrets:/run/secrets:ro \
              -e TS_HOSTNAME=nanoclaw-owner ${optionalString (cfg.tailscale.owner.tailnetCidrs != [ ]) "-e TS_ACCEPT_ROUTES=1"} \
              ${optionalString (cfg.tailscale.owner.exitNode != null) "-e TS_EXIT_NODE=${escapeShellArg cfg.tailscale.owner.exitNode}"} \
              ${tsRef}
          ''}";
          # nanogate joins conn-owner itself (gateStart), so it keeps the
          # network across its own restarts.
          Restart = "on-failure";
          RestartSec = 5;
          KillMode = "mixed";
        };
      };
      systemd.tmpfiles.rules = [ "d /var/lib/nanoclaw-ts 0711 root root -" ];
    })
  ]);
}
