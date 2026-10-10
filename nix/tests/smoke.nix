# Build-time smoke tests of the packaged artifacts (run on the aarch64 builder
# as ordinary derivations): native modules load, upstream's unpatched glibc
# binaries start through the nix loader, the runner's dependencies resolve.
{ pkgs, packages }:

let
  inherit (pkgs) lib;
  loader = if pkgs.stdenv.hostPlatform.isAarch64 then "ld-linux-aarch64.so.1" else "ld-linux-x86-64.so.2";
  viaLoader = "${pkgs.glibc}/lib/${loader} --library-path ${pkgs.glibc}/lib";
  image = packages.nanoclaw-agent-image;
  runner = packages.nanoclaw-runner-src;
  nodejs = pkgs.nodejs_22;
in
{
  host = pkgs.runCommand "nanoclaw-host-smoke" { } ''
    cd ${packages.nanoclaw-host}/lib/nanoclaw
    ${nodejs}/bin/node -e "
      const D = require('better-sqlite3');
      const db = new D(':memory:');
      console.log('host better-sqlite3', db.prepare('select sqlite_version() v').get().v);
    "
    test -f dist/index.js && test -f container/CLAUDE.md && test -d container/agent-runner/src
    ${packages.nanoclaw-host}/bin/nanoclaw-host --help >/dev/null 2>&1 || true
    touch $out
  '';

  nanogate = pkgs.runCommand "nanogate-smoke" { } ''
    cd ${packages.nanogate}/lib/nanogate
    ${pkgs.nodejs-slim_22}/bin/node -e "
      const D = require('better-sqlite3');
      console.log('nanogate better-sqlite3', new D(':memory:').prepare('select 1 x').get().x);
    "
    touch $out
  '';
} // lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux {
  agent-image = pkgs.runCommand "agent-image-smoke" { } ''
    echo "bun:        $(${viaLoader} ${image.bun}/bin/bun --version)"
    echo "claude:     $(${viaLoader} ${image.cliTools}/bin/claude --version)"
    echo "agent-browser: $(${viaLoader} ${image.cliTools}/lib/agent-browser/agent-browser --version)"
    echo "chromium:   $(${pkgs.chromium}/bin/chromium --version)"
    # Runner deps resolve under Bun (cwd = the runner tree, like /app in the image).
    cd ${runner}
    LD_LIBRARY_PATH=${pkgs.glibc}/lib ${viaLoader} ${image.bun}/bin/bun -e "
      import('@anthropic-ai/claude-agent-sdk').then(() => import('@modelcontextprotocol/sdk/server/index.js')).then(() => import('cron-parser')).then(() => import('zod')).then(() => console.log('runner deps ok'));
    "
    # Document tooling the agent cannot install at runtime.
    ${image.rootEnv}/bin/python -c "import openpyxl, docx, pypdf, PIL, pillow_heif; print('python doc libs ok')"
    ${image.rootEnv}/bin/pdftotext -v 2>&1 | head -1
        # The SDK's bundled native CLI is the same bytes as the global one.
    cmp ${runner}/node_modules/@anthropic-ai/claude-agent-sdk-linux-*/claude ${image.cliTools}/bin/claude
    touch $out
  '';
}
