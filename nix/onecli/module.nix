{
  config,
  lib,
  pkgs,
  ...
}:

let
  cfg = config.services.onecli;
  composeFile = ./docker-compose.yml;
in
{
  options.services.onecli = {
    enable = lib.mkEnableOption "OneCLI credential gateway (Podman-managed compose stack)";

    stateDir = lib.mkOption {
      type = lib.types.path;
      default = "/var/lib/onecli";
      description = ''
        Working directory for podman-compose. The compose file is read from
        the Nix store; named volumes (pgdata, app-data) live under
        ~/.local/share/containers/storage/volumes/ as usual for podman,
        managed by podman itself — this directory is mostly used as the
        working dir for compose state files.
      '';
    };

    bindHost = lib.mkOption {
      type = lib.types.str;
      default = "127.0.0.1";
      description = "Address to bind exposed ports to (gateway, app, postgres).";
    };

    appPort = lib.mkOption {
      type = lib.types.port;
      default = 10254;
      description = "Port for the OneCLI dashboard + admin API.";
    };

    gatewayPort = lib.mkOption {
      type = lib.types.port;
      default = 10255;
      description = "Port for the credential-injection HTTP gateway.";
    };

    version = lib.mkOption {
      type = lib.types.str;
      default = "latest";
      description = ''
        ghcr.io/onecli/onecli image tag to pull. Pin to a specific version
        for reproducibility; "latest" is fine for initial bring-up.
      '';
    };
  };

  config = lib.mkIf cfg.enable {
    environment.systemPackages = [
      pkgs.podman-compose
    ];

    systemd.tmpfiles.rules = [
      "d ${cfg.stateDir} 0750 root root -"
    ];

    systemd.services.onecli = {
      description = "OneCLI credential gateway (podman-compose)";
      wantedBy = [ "multi-user.target" ];
      after = [
        "network-online.target"
        "podman.service"
      ];
      wants = [ "network-online.target" ];
      requires = [ "podman.service" ];

      path = [
        pkgs.podman-compose
        pkgs.podman
        pkgs.gawk
        pkgs.coreutils
        "/run/current-system/sw"
      ];

      environment = {
        ONECLI_BIND_HOST = cfg.bindHost;
        ONECLI_APP_PORT = toString cfg.appPort;
        ONECLI_GATEWAY_PORT = toString cfg.gatewayPort;
        ONECLI_VERSION = cfg.version;
        # Persistent compose project state directory under stateDir so podman-compose
        # finds its named volumes consistently across restarts.
        COMPOSE_PROJECT_NAME = "onecli";
        HOME = cfg.stateDir;
      };

      serviceConfig = {
        Type = "simple";
        User = "root";
        WorkingDirectory = cfg.stateDir;
        ExecStartPre = pkgs.writeShellScript "onecli-pull" ''
          set -e
          ${pkgs.podman-compose}/bin/podman-compose -f ${composeFile} pull
        '';
        ExecStart = "${pkgs.podman-compose}/bin/podman-compose -f ${composeFile} up";
        ExecStop = "${pkgs.podman-compose}/bin/podman-compose -f ${composeFile} down";
        Restart = "on-failure";
        RestartSec = 10;
        TimeoutStartSec = 600;
      };
    };
  };
}
