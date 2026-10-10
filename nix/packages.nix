# All buildable outputs for one system. `root` is the flake source tree.
{ pkgs, root }:

let
  inherit (pkgs) lib;
  version = (builtins.fromJSON (builtins.readFile (root + "/package.json"))).version;
  call = lib.callPackageWith (pkgs // { inherit root version; });

  pnpmDeps = call ./pnpm-deps.nix { };
  nanorelay = call ./nanorelay.nix { };
  nanoclaw-miniapp = call ./miniapp.nix { inherit pnpmDeps; };
  nanoclaw-host = call ./host.nix { inherit pnpmDeps; };
  nanogate = call ./nanogate.nix { inherit pnpmDeps nanoclaw-host; };
in
{
  inherit nanorelay nanoclaw-miniapp nanoclaw-host nanogate;
  default = nanoclaw-host;
}
// lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux (
  let
    nanoclaw-runner-src = call ./runner-src.nix { };
    nanoclaw-agent-image = call ./agent-image.nix { inherit nanoclaw-runner-src; };
    nanogate-image = call ./nanogate-image.nix { inherit nanogate; };
    nanorelay-image = call ./nanorelay-image.nix { inherit nanorelay; };
    nanoclaw-tailscale-image = call ./tailscale-image.nix { };
  in
  {
    inherit nanoclaw-runner-src nanoclaw-agent-image nanogate-image nanorelay-image nanoclaw-tailscale-image;
    whisper-model-small = call ./whisper-model.nix { model = "small"; };
    whisper-model-large-v3-turbo-q5_0 = call ./whisper-model.nix { model = "large-v3-turbo-q5_0"; };
  }
)
