# The global Node CLIs the Dockerfile installs from container/cli-tools.json
# (claude-code, agent-browser), as pinned npm tarballs. Both packages ship
# per-platform prebuilt binaries (no download at install time), so unpacking the
# tarball is the whole install. Versions must match container/cli-tools.json;
# the assertion below makes drift a loud eval error, not a silent skew.
{ lib, stdenv, fetchurl, runCommand, makeWrapper, root, runnerSrc }:

let
  arch = if stdenv.hostPlatform.isAarch64 then "arm64" else "x64";

  manifest = builtins.fromJSON (builtins.readFile (root + "/container/cli-tools.json"));
  manifestVersion = name: (lib.findFirst (t: t.name == name) { version = "missing"; } manifest).version;

  claudeVersion = "2.1.280";
  agentBrowserVersion = "0.27.1";

  # sha512 integrity values straight from the npm registry (`npm view <pkg> dist.integrity`).
  claudeHashes = {
    arm64 = "sha512-zB4oqrFwimkV/FmBOkVxvv8iYgsuDSp7/MY8uYTns4SCE4DwdHz58X1cO1sgqLnCR96A0oU7Yirov1Uk3iGKAA==";
    x64 = "sha512-dJHWFrDSIZ26hdLucnK3ehLmzdzYl3MsPC1RzUctAUaYnZlH5kfAZxnK8qYRAQ89GX3OPrLsnFdt/QnP+0Ck6Q==";
  };

  claudeTarball = fetchurl {
    url = "https://registry.npmjs.org/@anthropic-ai/claude-code-linux-${arch}/-/claude-code-linux-${arch}-${claudeVersion}.tgz";
    hash = claudeHashes.${arch};
  };
  agentBrowserTarball = fetchurl {
    url = "https://registry.npmjs.org/agent-browser/-/agent-browser-${agentBrowserVersion}.tgz";
    hash = "sha512-lLzpWDV7nlVsA5km7yMCH1wppvnLLNx160hLwLdDUkCst9x38UhhxoiTmmJ2qreOnCa/Hp4/Gm6Adkahhtb6Hg==";
  };

  sdkBinary = "${runnerSrc}/node_modules/@anthropic-ai/claude-agent-sdk-linux-${arch}/claude";
in
assert lib.assertMsg
  (manifestVersion "@anthropic-ai/claude-code" == claudeVersion && manifestVersion "agent-browser" == agentBrowserVersion)
  "container/cli-tools.json versions changed: update nix/cli-tools.nix (versions + tarball hashes)";

runCommand "nanoclaw-cli-tools" { nativeBuildInputs = [ makeWrapper ]; } ''
  mkdir -p $out/bin $out/lib/agent-browser $TMPDIR/cc

  # claude: the native binary is what the package's postinstall copies over
  # bin/claude.exe. The agent-runner's SDK bundles the same binary; when the
  # bytes are identical, share one copy instead of shipping 230 MB twice.
  tar -xzf ${claudeTarball} -C $TMPDIR/cc
  if cmp -s $TMPDIR/cc/package/claude ${sdkBinary}; then
    ln -s ${sdkBinary} $out/bin/claude
  else
    install -m 0755 $TMPDIR/cc/package/claude $out/bin/claude
  fi

  # agent-browser: skip the Node shim, exec the native binary directly.
  mkdir -p $TMPDIR/ab
  tar -xzf ${agentBrowserTarball} -C $TMPDIR/ab
  install -m 0755 $TMPDIR/ab/package/bin/agent-browser-linux-${arch} $out/lib/agent-browser/agent-browser
  cp -r $TMPDIR/ab/package/skills $TMPDIR/ab/package/skill-data $out/lib/agent-browser/ 2>/dev/null || true
  ln -s $out/lib/agent-browser/agent-browser $out/bin/agent-browser
''
