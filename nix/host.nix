# The root pnpm project: tsc -> dist/, production node_modules, container/
# assets and templates. Everything the host reads at runtime from its working
# directory lives under $out/lib/nanoclaw and is linked into the state dir by
# the module's layout script.
{ lib, stdenv, nodejs_22, pnpm_10, makeWrapper, autoPatchelfHook, jq
, root, version, pnpmDeps }:

let
  nodejs = nodejs_22;
in
stdenv.mkDerivation {
  pname = "nanoclaw-host";
  inherit version pnpmDeps;

  src = lib.fileset.toSource {
    inherit root;
    fileset = lib.fileset.unions [
      (root + "/package.json")
      (root + "/pnpm-lock.yaml")
      (root + "/pnpm-workspace.yaml")
      (root + "/miniapp/package.json")
      (root + "/tsconfig.json")
      (root + "/src")
      (root + "/container")
      (root + "/templates")
    ];
  };

  nativeBuildInputs = [ nodejs pnpm_10 pnpm_10.configHook makeWrapper jq ]
    ++ lib.optionals stdenv.hostPlatform.isLinux [ autoPatchelfHook ];
  # better-sqlite3 ships N-API prebuilds (node-addon-api, ABI-stable across
  # Node versions); autoPatchelf points the linux ones at nixpkgs libstdc++.
  buildInputs = lib.optionals stdenv.hostPlatform.isLinux [ stdenv.cc.cc.lib ];
  # packageManager pins a newer pnpm than nixpkgs'; don't try to self-install it.
  env.npm_config_manage_package_manager_versions = "false";
  pnpmWorkspaces = [ "nanoclaw" ];

  buildPhase = ''
    runHook preBuild
    pnpm build
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall

    # Drop dev dependencies from the installed tree (offline, store is local).
    CI=true pnpm prune --prod --ignore-scripts

    dest=$out/lib/nanoclaw
    mkdir -p $dest $out/bin
    cp -r dist node_modules package.json $dest/
    cp -r container templates $dest/
    # Persona/guest prompt templates: tsc does not copy them into dist, so
    # ship them beside it; the module points NC_TEMPLATES_DIR here.
    cp -r src/nc/templates $dest/nc-templates
    # Agent-runner tests and the image recipe are not runtime inputs; the
    # image is built by nix (agent-image.nix), not from the Dockerfile.
    rm -f $dest/container/Dockerfile $dest/container/build.sh $dest/container/pull.sh
    find $dest/container -name '*.test.ts' -delete

    # Non-host platform prebuilds are dead weight.
    for d in $dest/node_modules/.pnpm/better-sqlite3@*/node_modules/better-sqlite3/prebuilds; do
      find "$d" -type f ! -name 'linux-${if stdenv.hostPlatform.isAarch64 then "arm64" else "x64"}.node' ${lib.optionalString stdenv.hostPlatform.isDarwin "! -name 'darwin-arm64.node'"} -delete
    done

    # Workspace links (miniapp) and anything else left dangling by the prune.
    find $dest/node_modules -xtype l -delete

    # No cd: the unit's WorkingDirectory (the state dir) is the project root
    # for the host (config.ts uses process.cwd()).
    makeWrapper ${nodejs}/bin/node $out/bin/nanoclaw-host \
      --add-flags $dest/dist/index.js
    makeWrapper ${nodejs}/bin/node $out/bin/ncl \
      --add-flags $dest/dist/cli/client.js

    runHook postInstall
  '';

  # node_modules/.pnpm contains many absolute-path-free symlinks; nothing to fix up.
  dontStrip = true;

  passthru = { inherit nodejs; libDir = "lib/nanoclaw"; };

  meta = {
    description = "NanoClaw host (Node) built from the pnpm lockfile";
    mainProgram = "nanoclaw-host";
  };
}
