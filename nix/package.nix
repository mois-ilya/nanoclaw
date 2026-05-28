{
  lib,
  stdenv,
  nodejs_22,
  pnpm_10,
  python3,
  makeWrapper,
  cctools,
}:

let
  nodejs = nodejs_22;
  pnpm = pnpm_10;
in
stdenv.mkDerivation (finalAttrs: {
  pname = "nanoclaw";
  version = "2.0.70";

  src = lib.cleanSource ./..;

  pnpmDeps = pnpm.fetchDeps {
    inherit (finalAttrs) pname version src;
    fetcherVersion = 2;
    hash = "sha256-xXlMpvUS8T3NKnkzYZrBcmG0ip7Z8yDltIWYUUuygAg=";
  };

  nativeBuildInputs = [
    nodejs
    pnpm.configHook
    python3
    makeWrapper
  ] ++ lib.optionals stdenv.isDarwin [ cctools ];

  env = {
    HUSKY = "0";
    npm_config_build_from_source = "true";
    npm_config_nodedir = nodejs;
  };

  buildPhase = ''
    runHook preBuild
    pnpm rebuild better-sqlite3
    pnpm run build
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall

    mkdir -p $out/libexec/nanoclaw
    cp -r dist node_modules package.json container $out/libexec/nanoclaw/

    makeWrapper ${nodejs}/bin/node $out/bin/nanoclaw \
      --add-flags "$out/libexec/nanoclaw/dist/index.js"

    runHook postInstall
  '';

  meta = {
    description = "NanoClaw — personal Claude assistant (host)";
    homepage = "https://github.com/nanoco/nanoclaw";
    license = lib.licenses.mit;
    mainProgram = "nanoclaw";
    platforms = lib.platforms.linux ++ lib.platforms.darwin;
  };
})
