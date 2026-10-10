# One fixed-output pnpm store for the whole workspace (root host project,
# miniapp). nanogate has no importer of its own: its only runtime dependency
# (better-sqlite3, exact pin) is also a root dependency, so it is built from
# this same store (see nanogate.nix).
#
# The source is the manifests only, so editing code never re-fetches, and the
# hash changes exactly when a lockfile or manifest does. After changing
# pnpm-lock.yaml: set `hash` to lib.fakeHash, build, paste the reported hash.
{ lib, pnpm_10, root, version }:

pnpm_10.fetchDeps {
  pname = "nanoclaw-pnpm-deps";
  inherit version;
  src = lib.fileset.toSource {
    root = root;
    fileset = lib.fileset.unions [
      (root + "/package.json")
      (root + "/pnpm-lock.yaml")
      (root + "/pnpm-workspace.yaml")
      (root + "/miniapp/package.json")
    ];
  };
  fetcherVersion = 3;
  hash = "sha256-DzA2gWLxkb+/Uvz+D99nuHI/v0TVIElcf59nY+0Z0eY=";
}
