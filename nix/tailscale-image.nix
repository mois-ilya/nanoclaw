# Owner tailnet connector (phase 1b): nixpkgs tailscale in userspace-networking
# mode with a SOCKS5 listener. Entrypoint starts tailscaled, waits for its
# socket, runs `tailscale up` with the auth key read from a mounted file, and
# stays in the foreground with tailscaled. No TUN device, no capabilities.
{ lib, dockerTools, tailscale, bash, coreutils, writeShellScript, version }:

let
  run = writeShellScript "nanoclaw-ts-connector" ''
    set -eu
    : "''${TS_STATE_DIR:=/state}"
    : "''${TS_SOCKS5:=0.0.0.0:1055}"
    : "''${TS_AUTHKEY_FILE:=/run/secrets/authkey}"
    : "''${TS_HOSTNAME:=nanoclaw-connector}"
    sock=/tmp/tailscaled.sock

    ${tailscale}/bin/tailscaled --tun=userspace-networking --socks5-server="$TS_SOCKS5" \
      --statedir="$TS_STATE_DIR" --socket="$sock" &
    daemon=$!
    trap 'kill "$daemon" 2>/dev/null || true' TERM INT

    for _ in $(seq 1 50); do [ -S "$sock" ] && break; sleep 0.2; done

    up="--socket=$sock up --hostname=$TS_HOSTNAME --accept-dns=false --reset"
    [ -s "$TS_AUTHKEY_FILE" ] && up="$up --authkey=file:$TS_AUTHKEY_FILE"
    [ -n "''${TS_EXIT_NODE:-}" ] && up="$up --exit-node=$TS_EXIT_NODE --exit-node-allow-lan-access=false"
    [ -n "''${TS_ACCEPT_ROUTES:-}" ] && up="$up --accept-routes"
    # shellcheck disable=SC2086
    ${tailscale}/bin/tailscale $up

    wait "$daemon"
  '';
  imageName = "nanoclaw-ts-connector";
  imageTag = "${version}-${builtins.substring 0 8 (builtins.hashString "sha256" (toString run))}";
in
(dockerTools.streamLayeredImage {
  name = imageName;
  tag = imageTag;
  contents = [ tailscale bash coreutils dockerTools.caCertificates ];
  fakeRootCommands = ''
    mkdir -p state tmp run/secrets
    chmod 1777 tmp
    chown 65532:65532 state
  '';
  config = {
    User = "65532:65532";
    Entrypoint = [ run ];
    Volumes = { "/state" = { }; };
    ExposedPorts = { "1055/tcp" = { }; };
  };
}).overrideAttrs (old: {
  passthru = (old.passthru or { }) // { inherit imageName imageTag; imageRef = "${imageName}:${imageTag}"; };
})
