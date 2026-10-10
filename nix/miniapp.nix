# Mini App «Кабинет»: Vite + Preact static build.
{ lib, stdenv, nodejs_22, pnpm_10, root, version, pnpmDeps }:

stdenv.mkDerivation {
  pname = "nanoclaw-miniapp";
  inherit version pnpmDeps;

  src = lib.fileset.toSource {
    inherit root;
    fileset = lib.fileset.unions [
      (root + "/package.json")
      (root + "/pnpm-lock.yaml")
      (root + "/pnpm-workspace.yaml")
      (root + "/miniapp")
    ];
  };

  nativeBuildInputs = [ nodejs_22 pnpm_10 pnpm_10.configHook ];
  # packageManager pins a newer pnpm than nixpkgs'; don't try to self-install it.
  env.npm_config_manage_package_manager_versions = "false";
  pnpmWorkspaces = [ "@nanoclaw/miniapp" ];

  buildPhase = ''
    runHook preBuild
    pnpm --filter @nanoclaw/miniapp build
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    mkdir -p $out
    cp -r miniapp/dist/. $out/
    runHook postInstall
  '';
}
