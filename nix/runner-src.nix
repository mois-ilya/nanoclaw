# The agent-runner tree: `src/` (what the host bind-mounts read-only at
# /app/src) and the Bun `node_modules` the image carries at /app/node_modules.
#
# Mirrors the Dockerfile: `bun install --frozen-lockfile` from package.json +
# bun.lock only. The install is a fixed-output derivation (network allowed,
# output hash pinned); the lockfile pins every package by integrity, the hash
# pins the resulting tree. After changing bun.lock: set the system's entry in
# `nodeModulesHashes` to lib.fakeHash, build `nanoclaw-runner-src`, paste the reported hash.
{ lib, stdenv, stdenvNoCC, bun, cacert, runCommand, root, version }:

let
  arch = if stdenv.hostPlatform.isAarch64 then "arm64" else "x64";
  runnerDir = root + "/container/agent-runner";

  nodeModulesHashes = {
    "aarch64-linux" = "sha256-Gg+aSPbKYEHStUJJfgjhd28Gnp9N/mdgftbwIscPfYA=";
  };

  nodeModules = stdenvNoCC.mkDerivation {
    pname = "nanoclaw-runner-node-modules";
    inherit version;
    src = lib.fileset.toSource {
      root = runnerDir;
      fileset = lib.fileset.unions [ (runnerDir + "/package.json") (runnerDir + "/bun.lock") ];
    };
    nativeBuildInputs = [ bun ];
    dontFixup = true;

    buildPhase = ''
      runHook preBuild
      export HOME=$TMPDIR
      export SSL_CERT_FILE=${cacert}/etc/ssl/certs/ca-bundle.crt
      export NODE_EXTRA_CA_CERTS=$SSL_CERT_FILE
      # --ignore-scripts: nothing in this tree needs a build step (the native
      # pieces ship as per-platform optional packages), and a FOD should not
      # run arbitrary lifecycle scripts.
      bun install --frozen-lockfile --ignore-scripts --no-progress
      runHook postBuild
    '';
    installPhase = ''
      runHook preInstall
      rm -rf node_modules/.cache
      cp -r node_modules $out
      runHook postInstall
    '';

    outputHashMode = "recursive";
    outputHashAlgo = "sha256";
    # bun installs the optional native packages that match the build platform,
    # so the tree (and the hash) is per system. Only the deploy target is pinned.
    outputHash = nodeModulesHashes.${stdenv.hostPlatform.system} or lib.fakeHash;
  };
in
runCommand "nanoclaw-runner-src-${version}" { passthru = { inherit nodeModules; }; } ''
  mkdir -p $out
  cp -r ${runnerDir}/src $out/src
  chmod -R u+w $out/src
  find $out/src -name '*.test.ts' -delete
  cp ${runnerDir}/package.json ${runnerDir}/bun.lock ${runnerDir}/tsconfig.json $out/

  cp -r ${nodeModules} $out/node_modules
  chmod -R u+w $out/node_modules
  # One native package per platform is enough: drop every other os/cpu/libc
  # variant of the SDK's bundled CLI (each is >100 MB).
  for d in $out/node_modules/@anthropic-ai/claude-agent-sdk-*; do
    case "$d" in
      */claude-agent-sdk-linux-${arch}) ;;
      *) rm -rf "$d" ;;
    esac
  done

  sha256sum ${runnerDir}/bun.lock | cut -d' ' -f1 > $out/bun.lock.sha256
''
