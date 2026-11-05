import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const scratch = existsSync('/var/tmp/scratch/opencode') ? '/var/tmp/scratch/opencode' : os.tmpdir();
const home = mkdtempSync(path.join(scratch, 'hela-runtime-tests-'));
try {
  const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', 'tests/timeout-recovery.test.mjs'], {
    stdio: 'inherit',
    env: { PATH: path.dirname(process.execPath), HOME: home, TMPDIR: home, XDG_CACHE_HOME: path.join(home, 'cache') },
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(home, { recursive: true, force: true });
}
