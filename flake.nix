{
  description = "HeLa Runtime - unified MCP daemon (profile-aware, lazy ignition, HTTP transport)";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
        nodejs = pkgs.nodejs_22;
      in
      {
        devShells.default = pkgs.mkShell {
          buildInputs = with pkgs; [
            nodejs
            typescript
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

        packages.default = pkgs.stdenv.mkDerivation {
          pname = "hela-runtime";
          version = "1.1.0";
          src = ./.;
          nativeBuildInputs = [ nodejs ];
          buildPhase = ''
            export HOME=$TMPDIR
            npm ci --ignore-scripts 2>/dev/null || npm install --ignore-scripts
            npm run build
          '';
          installPhase = ''
            mkdir -p $out/lib/hela-runtime
            cp -r dist package.json node_modules $out/lib/hela-runtime/
            mkdir -p $out/bin
            cat > $out/bin/hela-runtime <<WRAPPER
#!/usr/bin/env bash
exec ${nodejs}/bin/node $out/lib/hela-runtime/dist/index.js "\$@"
WRAPPER
            chmod +x $out/bin/hela-runtime
          '';
        };

        apps.default = {
          type = "app";
          program = "${self.packages.${system}.default}/bin/hela-runtime";
        };
      }
    );
}
