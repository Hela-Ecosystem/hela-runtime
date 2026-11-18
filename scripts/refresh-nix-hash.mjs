import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const flake = path.join(root, 'flake.nix');
const original = readFileSync(flake, 'utf8');
const hashLine = /npmDepsHash\s*=\s*"(sha256-[A-Za-z0-9+/=]+)";/g;
const matches = [...original.matchAll(hashLine)];
if (matches.length !== 1) throw new Error('Expected exactly one npmDepsHash in flake.nix');

const nix = spawnSync('nix', ['--version'], { cwd: root, encoding: 'utf8' });
if (nix.error?.code === 'ENOENT') {
  console.log('Nix is unavailable; flake.nix was not changed.');
  process.exit(0);
}
if (nix.status !== 0) throw new Error(nix.stderr || 'Unable to run nix --version');

const originalHash = matches[0][1];
const fakeHash = 'sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const replaceHash = (source, value) => source.replace(hashLine, `npmDepsHash = "${value}";`);
let verified = false;
try {
  writeFileSync(flake, replaceHash(original, fakeHash));
  const probe = spawnSync('nix', ['build', '.'], { cwd: root, encoding: 'utf8' });
  const output = `${probe.stdout ?? ''}\n${probe.stderr ?? ''}`;
  const expected = output.match(/got:\s*(sha256-[A-Za-z0-9+/=]+)/)?.[1];
  if (!expected || probe.status === 0) {
    throw new Error(`Nix did not report an npmDepsHash mismatch with an expected hash.\n${output.trim()}`);
  }

  writeFileSync(flake, replaceHash(original, expected));
  const confirmation = spawnSync('nix', ['build', '.'], { cwd: root, encoding: 'utf8' });
  if (confirmation.status !== 0) {
    throw new Error(`nix build failed after updating npmDepsHash.\n${confirmation.stderr || confirmation.stdout}`);
  }
  verified = true;
  console.log(`Updated npmDepsHash to ${expected}; nix build . succeeded.`);
} finally {
  if (!verified) writeFileSync(flake, replaceHash(readFileSync(flake, 'utf8'), originalHash));
}
