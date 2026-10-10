# The agent container image, equivalent to container/Dockerfile but assembled
# from nixpkgs instead of Debian: no apt, no curl|bash, no registry pull at
# build time. Streamed (never stored as a tarball); `podman load` consumes it.
#
# Path contract with the host (src/container-runner.ts, container/Dockerfile):
#   /app/src            bind-mounted read-only by the host at spawn
#   /app/node_modules   Bun deps (from nanoclaw-runner-src)
#   /app/entrypoint.sh  upstream's entrypoint
#   /workspace/{group,extra}, /home/node (uid 1000 "node")
#   bun, node, chromium, claude, agent-browser, ncl on PATH
{ lib, stdenv, dockerTools, buildEnv, runCommand, writeText, fetchurl, unzip
, bash, coreutils, findutils, gnugrep, gnused, gawk, gnutar, gzip, curl, git, tini
, ripgrep, python3, poppler-utils, tzdata, glibcLocales, procps, less, nodejs_22, pnpm_10, chromium, liberation_ttf
, noto-fonts-color-emoji, makeFontsConf, glibc, cacert
, callPackage, root, version, nanoclaw-runner-src }:

let
  arch = if stdenv.hostPlatform.isAarch64 then "arm64" else "x64";
  bunArch = if stdenv.hostPlatform.isAarch64 then "aarch64" else "x64";
  loader = if stdenv.hostPlatform.isAarch64 then "ld-linux-aarch64.so.1" else "ld-linux-x86-64.so.2";

  # Pinned like the Dockerfile's BUN_VERSION. The official binary is only
  # linked against glibc; with the loader linked at /lib it runs unpatched.
  bunVersion = "1.4.0";
  bun = stdenv.mkDerivation {
    pname = "bun";
    version = bunVersion;
    src = fetchurl {
      url = "https://github.com/oven-sh/bun/releases/download/bun-v${bunVersion}/bun-linux-${bunArch}.zip";
      hash = {
        arm64 = "sha256-SxozLuhhmD65O8/m93D/+U4+MbLDiL2uo8jtNeWO7Q4=";
        x64 = "sha256-LQP7X7g6yLVnrKCigbLOGhoZ1Ij1bClo2Iw/Jekv5FI=";
      }.${arch};
    };
    nativeBuildInputs = [ unzip ];
    dontConfigure = true;
    dontBuild = true;
    dontFixup = true; # patchelf would corrupt nothing here, but the point is to ship upstream's bytes
    installPhase = "install -Dm755 bun $out/bin/bun";
  };

  cliTools = callPackage ./cli-tools.nix { inherit root; runnerSrc = nanoclaw-runner-src; };

  fontsConf = makeFontsConf { fontDirectories = [ liberation_ttf noto-fonts-color-emoji ]; };

  # `ncl` inside the container: same wrapper as the Dockerfile writes.
  ncl = writeText "ncl" ''
    #!/bin/sh
    exec bun /app/src/cli/ncl.ts "$@"
  '';

  # Document tooling (podman has no image rebuilds, so installs are impossible
  # at runtime): xlsx/docx/pdf/HEIC from Python, pdftotext & co from poppler.
  # pandoc (~200 MB closure) and libreoffice are deliberately left out.
  python = python3.withPackages (ps: [ ps.openpyxl ps.python-docx ps.pypdf ps.pillow ps.pillow-heif ]);
  locales = glibcLocales.override { allLocales = false; locales = [ "ru_RU.UTF-8/UTF-8" "en_US.UTF-8/UTF-8" ]; };

  # The session driver runs agents with --no-hosts (no host.containers.internal),
  # which makes podman use the image's /etc/hosts as is; fakeNss ships none, so
  # without this `localhost` would go to aardvark-dns on the internal network.
  etcHosts = runCommand "nanoclaw-agent-etc-hosts" { } ''
    mkdir -p $out/etc
    printf '127.0.0.1 localhost\n::1 localhost ip6-localhost ip6-loopback\n' > $out/etc/hosts
  '';

  rootEnv = buildEnv {
    name = "nanoclaw-agent-root";
    pathsToLink = [ "/bin" "/etc" "/share" ];
    paths = [
      bash coreutils findutils gnugrep gnused gawk gnutar gzip unzip curl git tini ripgrep
      python poppler-utils procps less nodejs_22 pnpm_10 chromium bun cliTools etcHosts
    ];
  };

  nss = dockerTools.fakeNss.override {
    extraPasswdLines = [ "node:x:1000:1000:node:/home/node:/bin/bash" ];
    extraGroupLines = [ "node:x:1000:" ];
  };

  imageName = "nanoclaw-agent";
  # Deterministic: derived from the store paths of everything that lands in the image.
  contentHash = builtins.substring 0 8 (builtins.hashString "sha256"
    (builtins.toJSON (map toString [ rootEnv locales nanoclaw-runner-src fontsConf nss ncl (root + "/container/entrypoint.sh") ])));
  imageTag = "${version}-${contentHash}";

  image = dockerTools.streamLayeredImage {
    name = imageName;
    tag = imageTag;
    maxLayers = 100;

    contents = [ rootEnv nss dockerTools.usrBinEnv dockerTools.binSh dockerTools.caCertificates ];

    # Runs as root under fakeroot: ownership set here ends up in the layers.
    fakeRootCommands = ''
      mkdir -p tmp home/node workspace/group workspace/extra app usr/local/bin lib
      chmod 1777 tmp
      chmod 0777 home/node
      # agent-browser profile: cookies/logins persist across browser restarts
      mkdir -p home/node/.agent-browser/profile
      chmod -R 0777 home/node/.agent-browser
      chown -R 1000:1000 workspace

      # glibc dynamic loader at the FHS path: upstream ships Bun and the Claude
      # CLI as unpatched glibc binaries whose PT_INTERP is /lib/${loader}.
      ln -s ${glibc}/lib/${loader} lib/${loader}

      # The Claude Code SDK is pointed at /pnpm/claude (providers/claude.ts).
      mkdir -p pnpm
      ln -s ${cliTools}/bin/claude pnpm/claude
      ln -s ${cliTools}/bin/agent-browser pnpm/agent-browser

      ln -s ${nanoclaw-runner-src}/node_modules app/node_modules
      cp ${nanoclaw-runner-src}/package.json app/package.json
      install -m 0755 ${root + "/container/entrypoint.sh"} app/entrypoint.sh
      install -m 0755 ${ncl} usr/local/bin/ncl
    '';

    config = {
      Entrypoint = [ "/bin/tini" "--" "/app/entrypoint.sh" ];
      User = "node";
      WorkingDir = "/workspace/group";
      Env = [
        "PATH=/usr/local/bin:/bin:/app/node_modules/.bin"
        "HOME=/home/node"
        "LD_LIBRARY_PATH=${glibc}/lib"
        "SSL_CERT_FILE=${cacert}/etc/ssl/certs/ca-bundle.crt"
        "NODE_EXTRA_CA_CERTS=${cacert}/etc/ssl/certs/ca-bundle.crt"
        "FONTCONFIG_FILE=${fontsConf}"
        "LANG=ru_RU.UTF-8"
        "LOCALE_ARCHIVE=${locales}/lib/locale/locale-archive"
        "TZDIR=${tzdata}/share/zoneinfo"
        # Inside the bind-mounted group dir, so cookies and logins survive idle stops,
        # restarts and redeploys (agent containers are --rm). Per agent group = per user.
        "AGENT_BROWSER_PROFILE=/workspace/agent/.browser-profile"
        "AGENT_BROWSER_EXECUTABLE_PATH=${chromium}/bin/chromium"
        "PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=${chromium}/bin/chromium"
        "PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1"
      ];
      Labels = {
        "dev.nanoclaw.agent-runner-lock-sha256" = builtins.hashFile "sha256" (root + "/container/agent-runner/bun.lock");
        "dev.nanoclaw.image-source" = "nix";
      };
    };
  };
in
image.overrideAttrs (old: {
  passthru = (old.passthru or { }) // {
    inherit imageName imageTag bun cliTools rootEnv;
    imageRef = "${imageName}:${imageTag}";
  };
})
