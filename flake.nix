{
  description = "NanoClaw (mois-ilya fork): host, nanogate, nanorelay, Mini App, agent image and the NixOS module";

  # The consumer (nixserver) overrides this with `inputs.nixpkgs.follows = "nixpkgs"`,
  # so the pin below only matters for a standalone `nix build` in this repo.
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-25.11";

  outputs = { self, nixpkgs }:
    let
      inherit (nixpkgs) lib;
      # Images and the service stack are Linux-only; darwin gets the pure
      # build outputs for local checks.
      systems = [ "aarch64-linux" "x86_64-linux" "aarch64-darwin" ];
      forSystems = lib.genAttrs systems;
      mkPackages = system: import ./nix/packages.nix {
        pkgs = nixpkgs.legacyPackages.${system};
        root = ./.;
      };
    in
    {
      packages = forSystems mkPackages;

      nixosModules.nanoclaw = import ./nix/module.nix { inherit self; };
      nixosModules.default = self.nixosModules.nanoclaw;

      checks = lib.genAttrs [ "aarch64-linux" "x86_64-linux" ] (system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
          smoke = import ./nix/tests/smoke.nix { inherit pkgs; packages = self.packages.${system}; };
        in
        {
          module-eval = import ./nix/tests/module-eval.nix { inherit pkgs self nixpkgs; };
          smoke-host = smoke.host;
          smoke-nanogate = smoke.nanogate;
          smoke-agent-image = smoke.agent-image;
        });
    };
}
