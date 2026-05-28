{
  config,
  lib,
  pkgs,
  ...
}:

let
  cfg = config.services.nanoclaw;
in
{
  options.services.nanoclaw = {
    enable = lib.mkEnableOption "NanoClaw AI assistant";

    package = lib.mkOption {
      type = lib.types.package;
      description = ''
        The nanoclaw host derivation. Must contain $out/libexec/nanoclaw with
        dist/, node_modules/, package.json and container/ at the top level.
      '';
    };

    user = lib.mkOption {
      type = lib.types.str;
      default = "nanoclaw";
      description = "System user the service runs as.";
    };

    group = lib.mkOption {
      type = lib.types.str;
      default = "nanoclaw";
      description = "System group for the service user.";
    };

    dataDir = lib.mkOption {
      type = lib.types.path;
      default = "/var/lib/nanoclaw";
      description = ''
        Persistent data directory. Holds groups/, data/, store/, .env
        materialized at activation. Source code is referenced from the
        Nix store via cfg.package; nothing is rsynced in.
      '';
    };

    assistantName = lib.mkOption {
      type = lib.types.str;
      default = "Andy";
      description = "Display name for the assistant.";
    };

    containerImage = lib.mkOption {
      type = lib.types.str;
      default = "nanoclaw-agent:latest";
      description = "Container image used to spawn per-session agents.";
    };

    maxConcurrentContainers = lib.mkOption {
      type = lib.types.int;
      default = 1;
      description = "Maximum number of concurrent agent containers.";
    };

    containerRuntime = lib.mkOption {
      type = lib.types.enum [
        "podman"
        "docker"
      ];
      default = "podman";
      description = "Container runtime backend.";
    };

    secrets = {
      telegramBotTokenFile = lib.mkOption {
        type = lib.types.path;
        description = ''
          Path to a file containing TELEGRAM_BOT_TOKEN=... — typically a
          sops-nix or agenix secret. Path is passed to the systemd unit
          via EnvironmentFile, so it must be a single VAR=value line.
        '';
      };

      claudeOauthTokenFile = lib.mkOption {
        type = lib.types.path;
        description = ''
          Path to a file containing CLAUDE_CODE_OAUTH_TOKEN=... — also
          loaded via EnvironmentFile. Will be migrated to OneCLI later;
          for now the credential proxy reads it from process env.
        '';
      };
    };

    extraGroups = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ "podman" ];
      description = "Supplementary groups for the service user (e.g. for rootful podman socket access).";
    };

    resources = {
      memoryHigh = lib.mkOption {
        type = lib.types.str;
        default = "2G";
        description = "Soft memory limit for the nanoclaw cgroup slice.";
      };
      memoryMax = lib.mkOption {
        type = lib.types.str;
        default = "3G";
        description = "Hard memory limit for the nanoclaw cgroup slice.";
      };
      cpuQuota = lib.mkOption {
        type = lib.types.str;
        default = "150%";
        description = "CPU quota for the nanoclaw cgroup slice.";
      };
      hostMemoryMax = lib.mkOption {
        type = lib.types.str;
        default = "512M";
        description = "Hard memory limit for the host node process itself.";
      };
    };
  };

  config = lib.mkIf cfg.enable {
    users.users.${cfg.user} = {
      isSystemUser = true;
      group = cfg.group;
      extraGroups = cfg.extraGroups;
      home = cfg.dataDir;
      createHome = true;
    };
    users.groups.${cfg.group} = { };

    systemd.tmpfiles.rules = [
      "d ${cfg.dataDir} 0750 ${cfg.user} ${cfg.group} -"
      "d ${cfg.dataDir}/groups 0750 ${cfg.user} ${cfg.group} -"
      "d ${cfg.dataDir}/data 0750 ${cfg.user} ${cfg.group} -"
      "d ${cfg.dataDir}/store 0750 ${cfg.user} ${cfg.group} -"
      "d ${cfg.dataDir}/logs 0750 ${cfg.user} ${cfg.group} -"
    ];

    environment.etc."nanoclaw/env".text = ''
      ASSISTANT_NAME=${cfg.assistantName}
      CONTAINER_IMAGE=${cfg.containerImage}
      MAX_CONCURRENT_CONTAINERS=${toString cfg.maxConcurrentContainers}
      CONTAINER_RUNTIME=${cfg.containerRuntime}
      TZ=UTC
    '';

    systemd.slices.nanoclaw = {
      description = "NanoClaw resource slice";
      sliceConfig = {
        MemoryHigh = cfg.resources.memoryHigh;
        MemoryMax = cfg.resources.memoryMax;
        CPUQuota = cfg.resources.cpuQuota;
      };
    };

    systemd.services.nanoclaw = {
      description = "NanoClaw AI Assistant";
      wantedBy = [ "multi-user.target" ];
      after = [
        "network-online.target"
        "${cfg.containerRuntime}.service"
      ];
      wants = [ "network-online.target" ];

      path = [
        pkgs.${cfg.containerRuntime}
        "/run/current-system/sw"
        pkgs.nodejs_22
        pkgs.git
      ];

      environment = lib.mkMerge [
        (lib.mkIf (cfg.containerRuntime == "podman") {
          CONTAINER_HOST = "unix:///run/podman/podman.sock";
        })
        {
          NANOCLAW_DATA_DIR = cfg.dataDir;
        }
      ];

      serviceConfig = {
        Type = "simple";
        User = cfg.user;
        Group = cfg.group;
        Slice = "nanoclaw.slice";
        WorkingDirectory = cfg.dataDir;
        # Materialize a .env file in the working dir from the sops-managed
        # KEY=VALUE secret files. The host (src/env.ts) reads .env from cwd
        # rather than process env so credentials don't leak to child
        # processes (agent containers). Non-secret config goes via
        # EnvironmentFile=/etc/nanoclaw/env as normal systemd env.
        ExecStartPre = pkgs.writeShellScript "nanoclaw-prepare-env" ''
          set -e
          umask 077
          cat ${cfg.secrets.telegramBotTokenFile} ${cfg.secrets.claudeOauthTokenFile} > ${cfg.dataDir}/.env
        '';
        ExecStart = "${pkgs.nodejs_22}/bin/node ${cfg.package}/libexec/nanoclaw/dist/index.js";
        Restart = "always";
        RestartSec = 10;
        MemoryMax = cfg.resources.hostMemoryMax;

        ProtectHome = true;
        NoNewPrivileges = true;
        SupplementaryGroups = cfg.extraGroups;

        EnvironmentFile = [ "/etc/nanoclaw/env" ];
      };
    };
  };
}
