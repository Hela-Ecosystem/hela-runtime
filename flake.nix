{
  description = "HeLa Runtime - supervised, profile-aware MCP daemon with stdio and HTTP transport";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
      perSystem = forAllSystems (system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
          nodejs = pkgs.nodejs_22;
        in
        {
          devShells.default = pkgs.mkShell {
            packages = with pkgs; [
              nodejs
              sqlite
              curl
              git
            ];
            shellHook = ''
              echo "HeLa Runtime dev shell (Node $(node --version))"
              echo "Build: npm run build"
              echo "Run:   HELA_ECOSYSTEM_ROOT=/path/to/hela-mcp-ecosystem node dist/index.js"
            '';
          };

          packages.default = (pkgs.buildNpmPackage.override { inherit nodejs; }) {
            pname = "hela-runtime";
            version = (builtins.fromJSON (builtins.readFile ./package.json)).version;
            src = pkgs.lib.cleanSourceWith {
              src = ./.;
              filter = path: type:
                let name = builtins.baseNameOf path; in
                pkgs.lib.cleanSourceFilter path type
                && !(builtins.elem (builtins.baseNameOf path) [
                  "node_modules" "dist" ".git" ".direnv" "result" ".env" "memory.db" "coverage"
                ])
                && !(pkgs.lib.hasPrefix ".env." name)
                && !(pkgs.lib.hasPrefix "memory.db-" name)
                && !(pkgs.lib.hasPrefix "result-" name);
            };
            npmDepsHash = "sha256-hwIeRItQw4PWGCByevxWe+erdxrrHcHnYBgb2Unj/iw=";
            npmFlags = [ "--ignore-scripts" ];
            meta = {
              mainProgram = "hela-runtime";
              description = "Supervised, profile-aware HeLa MCP runtime";
              license = pkgs.lib.licenses.mit;
            };
          };

          apps.default = {
            type = "app";
            program = "${self.packages.${system}.default}/bin/hela-runtime";
            meta.description = "Run the HeLa MCP runtime";
          };
        }
      );
    in {
      packages = forAllSystems (system: perSystem.${system}.packages);
      apps = forAllSystems (system: perSystem.${system}.apps);
      devShells = forAllSystems (system: perSystem.${system}.devShells);
    };
}
