# nanogate: tsc over nanogate/src using the root workspace's toolchain, plus a
# runtime tree holding only better-sqlite3 and its dependency closure.
{ lib, stdenv, nodejs_22, nodejs-slim_22, pnpm_10, autoPatchelfHook, makeWrapper
, root, version, pnpmDeps, nanoclaw-host }:

stdenv.mkDerivation {
  pname = "nanogate";
  inherit version pnpmDeps;

  src = lib.fileset.toSource {
    inherit root;
    fileset = lib.fileset.unions [
      (root + "/package.json")
      (root + "/pnpm-lock.yaml")
      (root + "/pnpm-workspace.yaml")
      (root + "/miniapp/package.json")
      (root + "/nanogate/package.json")
      (root + "/nanogate/tsconfig.json")
      (root + "/nanogate/tsconfig.build.json")
      (root + "/nanogate/src")
    ];
  };

  nativeBuildInputs = [ nodejs_22 pnpm_10 pnpm_10.configHook makeWrapper ]
    ++ lib.optionals stdenv.hostPlatform.isLinux [ autoPatchelfHook ];
  buildInputs = lib.optionals stdenv.hostPlatform.isLinux [ stdenv.cc.cc.lib ];
  # packageManager pins a newer pnpm than nixpkgs'; don't try to self-install it.
  env.npm_config_manage_package_manager_versions = "false";
  pnpmWorkspaces = [ "nanoclaw" ];

  buildPhase = ''
    runHook preBuild
    # Resolves better-sqlite3 / @types/* / typescript from the root node_modules.
    pnpm exec tsc -p nanogate/tsconfig.build.json
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    dest=$out/lib/nanogate
    mkdir -p $dest/node_modules $out/bin
    cp -r nanogate/dist $dest/dist
    cp nanogate/package.json $dest/

    # Runtime closure of better-sqlite3 (and nothing else) out of the pnpm
    # virtual store, keeping its relative-symlink layout.
    store=node_modules/.pnpm
    sqlite=$(echo $store/better-sqlite3@*)
    mkdir -p $dest/node_modules/.pnpm
    cp -r --no-preserve=mode $sqlite $dest/node_modules/.pnpm/
    for dep in $store/node-addon-api@*; do
      cp -r --no-preserve=mode $dep $dest/node_modules/.pnpm/
    done
    ln -s .pnpm/$(basename $sqlite)/node_modules/better-sqlite3 $dest/node_modules/better-sqlite3

    # Platform prebuilds other than ours.
    find $dest/node_modules/.pnpm -path '*prebuilds*' -type f ! -name 'linux-${if stdenv.hostPlatform.isAarch64 then "arm64" else "x64"}.node' ${lib.optionalString stdenv.hostPlatform.isDarwin "! -name 'darwin-arm64.node'"} -delete

    # slim node (no npm/corepack): this closure goes into the gateway image.
    makeWrapper ${nodejs-slim_22}/bin/node $out/bin/nanogate --add-flags $dest/dist/main.js
    runHook postInstall
  '';

  dontStrip = true;
  meta.mainProgram = "nanogate";
}
