# Evaluation test: a minimal NixOS system using the module with dummy secret
# paths, in both firewall backends, with every optional feature on. Builds the
# generated scripts (shellcheck runs inside writeShellApplication) and dumps the
# interesting parts of the config so a regression shows up as a diff.
{ pkgs, self, nixpkgs }:

let
  # Stand-in for the host package so this test does not depend on the TypeScript
  # tree compiling: the module only needs a version and the install layout.
  stubHost = pkgs.runCommand "nanoclaw-host-stub-1.0.0" { version = "1.0.0"; } ''
    mkdir -p $out/bin $out/lib/nanoclaw
    printf '#!/bin/sh\nexit 0\n' > $out/bin/nanoclaw-host
    cp $out/bin/nanoclaw-host $out/bin/ncl
    chmod +x $out/bin/*
  '';

  mkSystem = { nftables ? false, copy ? false }: nixpkgs.lib.nixosSystem {
    inherit (pkgs.stdenv.hostPlatform) system;
    modules = [
      self.nixosModules.nanoclaw
      ({ lib, ... }: {
        system.stateVersion = "25.11";
        boot.loader.grub.enable = false;
        fileSystems."/" = { device = "none"; fsType = "tmpfs"; };
        virtualisation.podman.enable = true;
        networking.firewall.enable = true;
        networking.nftables.enable = nftables;
        services.caddy.enable = true;
        services.nanoclaw = {
          enable = true;
          package = stubHost;
          installId = "test";
          ownerTelegramId = 1;
          layout = if copy then "copy" else "symlink";
          telegram.tokenFile = "/run/dummy/telegram";
          anthropicKeyFile = "/run/dummy/anthropic";
          nanogate = {
            encryptionKeyFile = "/run/dummy/gate-key";
            pricesFile = pkgs.writeText "prices.json" ''{"version":"test","models":{},"serverTools":{}}'';
            hostAddresses = [ "203.0.113.7" ];
          };
          miniapp = { enable = true; domain = "claw.example.test"; shortName = "cabinet"; };
          # a tiny stand-in keeps the 466 MB real model out of this test
          stt = { enable = true; model = pkgs.writeText "ggml-test.bin" "x"; };
          tailscale.owner = { enable = true; authKeyFile = "/run/dummy/ts"; exitNode = "nXXXX"; tailnetCidrs = [ "192.168.8.0/24" ]; tailnetAllow = [ "192.168.8.1:80" "*.ts.net:443" ]; };
          alertCommand = "/run/dummy/alert";
        };
      })
    ];
  };

  ipt = mkSystem { };
  nft = mkSystem { nftables = true; copy = true; };
  unitsOf = s: builtins.attrNames s.config.systemd.services;
in
let
  svc = s: n: s.config.systemd.services.${n}.serviceConfig;
  execs = s: builtins.concatLists (map
    (n: pkgs.lib.flatten (map (k: (svc s n).${k} or [ ]) [ "ExecStartPre" "ExecStart" "ExecStartPost" ]))
    [ "nanoclaw" "nanogate" "nanoclaw-images" "nanoclaw-networks" "nanoclaw-backup" "nanoclaw-ts-owner" "nanoclaw-stt" ]);
in
let
  env = ipt.config.systemd.services.nanoclaw.environment;
  sttExec = (svc ipt "nanoclaw-stt").ExecStart;
  want = cond: msg: if cond then true else throw "module-eval: ${msg}";
  prices = builtins.fromJSON (builtins.readFile ../default-prices.json);
  neededModels = [ "claude-haiku-5-5" "claude-sonnet-5-5" "claude-opus-5-5" ];
  neededTools = [ "web_search" "web_fetch" ];
  # a second system with the defaults only: exit node default + no alert command
  defEnv = (nixpkgs.lib.nixosSystem {
    inherit (pkgs.stdenv.hostPlatform) system;
    modules = [
      self.nixosModules.nanoclaw
      ({ ... }: {
        system.stateVersion = "25.11";
        boot.loader.grub.enable = false;
        fileSystems."/" = { device = "none"; fsType = "tmpfs"; };
        virtualisation.podman.enable = true;
        networking.firewall.enable = true;
        services.nanoclaw = {
          enable = true; package = stubHost; installId = "test"; ownerTelegramId = 1;
          telegram.tokenFile = "/run/dummy/telegram"; anthropicKeyFile = "/run/dummy/anthropic";
          nanogate.encryptionKeyFile = "/run/dummy/gate-key";
          tailscale.owner = { enable = true; authKeyFile = "/run/dummy/ts"; };
        };
      })
    ];
  }).config.systemd.services.nanoclaw.environment;
in
assert want (env.NC_OWNER_EXIT_NODE == "nXXXX") "NC_OWNER_EXIT_NODE missing";
assert want (env.NC_OWNER_TAILNET_ALLOW == "192.168.8.1:80,*.ts.net:443") "NC_OWNER_TAILNET_ALLOW wrong";
assert want (env.NC_ALERT_COMMAND == "/run/dummy/alert") "NC_ALERT_COMMAND missing";
assert want (defEnv.NC_OWNER_EXIT_NODE == "gl-mt3000-beryl") "default exit node should be gl-mt3000-beryl";
assert want (!(defEnv ? NC_ALERT_COMMAND)) "NC_ALERT_COMMAND must be unset by default";
assert want (builtins.all (m: prices.models ? ${m}) neededModels) "default prices miss a model";
assert want (builtins.all (t: prices.serverTools ? ${t}) neededTools) "default prices miss a server tool";
assert want (env.NC_STOP_ENABLED == "1") "NC_STOP_ENABLED missing";
assert want (env.NC_STT_URL == "http://127.0.0.1:8091") "NC_STT_URL missing";
assert want (pkgs.lib.hasSuffix "/nc-templates" env.NC_TEMPLATES_DIR) "NC_TEMPLATES_DIR missing";
assert want (env ? NC_DEFAULT_TZ && env ? NC_MAX_CONTAINERS && env ? NANORELAY_IMAGE && env ? NC_MINIAPP_URL) "host env incomplete";
assert want (pkgs.lib.hasInfix "--tmp-dir /tmp" sttExec) "whisper-server needs --tmp-dir";
pkgs.runCommand "nanoclaw-module-eval"
  {
    # Evaluating both toplevels proves the module evaluates; referencing the
    # generated scripts builds them (shellcheck runs inside writeShellApplication).
    iptToplevel = builtins.unsafeDiscardStringContext ipt.config.system.build.toplevel.drvPath;
    nftToplevel = builtins.unsafeDiscardStringContext nft.config.system.build.toplevel.drvPath;
    scripts = builtins.toJSON (execs ipt ++ execs nft);
    iptablesRules = ipt.config.networking.firewall.extraCommands;
    nftablesRules = nft.config.networking.nftables.tables.nanoclaw.content;
    units = builtins.concatStringsSep "\n" (builtins.filter (n: pkgs.lib.hasPrefix "nano" n) (unitsOf ipt));
    hostEnv = builtins.toJSON ipt.config.systemd.services.nanoclaw.environment;
  }
  ''
    mkdir -p $out
    echo "$units" > $out/units
    echo "$hostEnv" > $out/host-env.json
    echo "$iptablesRules" > $out/iptables-rules.sh
    echo "$nftablesRules" > $out/nftables-rules.nft
  ''
