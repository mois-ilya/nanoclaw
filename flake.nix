{
  description = "NanoClaw — personal Claude assistant (host service + NixOS module)";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-25.11";
  };

  outputs =
    { self, nixpkgs }:
    let
      forAllSystems = nixpkgs.lib.genAttrs nixpkgs.lib.systems.flakeExposed;
      pkgsFor = system: import nixpkgs { inherit system; };
    in
    {
      packages = forAllSystems (
        system:
        let
          pkgs = pkgsFor system;
        in
        {
          nanoclaw-host = pkgs.callPackage ./nix/package.nix { };
          default = self.packages.${system}.nanoclaw-host;
        }
      );

      nixosModules = rec {
        nanoclaw = ./nix/module.nix;
        onecli = ./nix/onecli/module.nix;
        default = nanoclaw;
      };
    };
}
