# Static TCP forwarder of the session-container topology. No dependencies.
{ lib, buildGoModule, root }:

buildGoModule {
  pname = "nanorelay";
  version = "0.1.0";

  src = lib.fileset.toSource {
    root = root + "/nanorelay";
    fileset = root + "/nanorelay";
  };

  vendorHash = null;
  env.CGO_ENABLED = "0";
  ldflags = [ "-s" "-w" ];
  # Source dir is the module root; the binary takes the module's last path element.
  subPackages = [ "." ];
}
