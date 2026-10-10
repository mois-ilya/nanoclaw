# Minimal image: the static nanorelay binary and nothing else (no shell, no libc, no CA bundle).
{ dockerTools, nanorelay }:

let
  imageName = "nanorelay";
  imageTag = "${nanorelay.version}-${builtins.substring 0 8 (builtins.hashString "sha256" (toString nanorelay))}";
in
(dockerTools.streamLayeredImage {
  name = imageName;
  tag = imageTag;
  contents = [ nanorelay ];
  config = {
    User = "65532:65532";
    Entrypoint = [ "${nanorelay}/bin/nanorelay" ];
  };
}).overrideAttrs (old: {
  passthru = (old.passthru or { }) // { inherit imageName imageTag; imageRef = "${imageName}:${imageTag}"; };
})
