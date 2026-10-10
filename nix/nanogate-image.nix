# nanogate container image: slim Node + the built gateway, UID 65532.
# Secrets and config are bind-mounted at run time (see module.nix), never baked in.
{ lib, dockerTools, nanogate, version }:

let
  imageName = "nanogate";
  imageTag = "${version}-${builtins.substring 0 8 (builtins.hashString "sha256" (toString nanogate))}";
in
(dockerTools.streamLayeredImage {
  name = imageName;
  tag = imageTag;
  contents = [ nanogate dockerTools.caCertificates ];
  fakeRootCommands = ''
    mkdir -p var/lib/nanogate run/nanogate tmp
    chmod 1777 tmp
    chown 65532:65532 var/lib/nanogate run/nanogate
  '';
  config = {
    User = "65532:65532";
    Entrypoint = [ "${nanogate}/bin/nanogate" ];
    Volumes = { "/var/lib/nanogate" = { }; };
    ExposedPorts = { "8080/tcp" = { }; "3128/tcp" = { }; "8090/tcp" = { }; };
    Env = [ "SSL_CERT_FILE=/etc/ssl/certs/ca-bundle.crt" ];
  };
}).overrideAttrs (old: {
  passthru = (old.passthru or { }) // { inherit imageName imageTag; imageRef = "${imageName}:${imageTag}"; };
})
