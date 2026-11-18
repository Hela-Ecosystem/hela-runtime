import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  bootCell,
  callTool,
  CellDirectoryError,
  CellProtocolError,
  resolveDir,
  shutdownCell,
} from '../dist/cell-loader.js';

const fixture = new URL('./fixtures/protocol-cell.mjs', import.meta.url);

function sandbox(mode, id = 'hela-protocol') {
  // Nest the root so its parent candidate is a fresh, empty directory.
  const root = path.join(mkdtempSync(path.join(os.tmpdir(), 'protocol-')), 'install');
  const dir = path.join(root, 'cells', id);
  mkdirSync(dir, { recursive: true });
  copyFileSync(fixture, path.join(dir, `${mode}.mjs`));
  return { root, dir, spec: { id, alias: id, source: 'protocol-fixture', dir: `cells/${id}`, entry: `${mode}.mjs` } };
}

function elsewhere(t) {
  const previous = process.cwd();
  const away = mkdtempSync(path.join(os.tmpdir(), 'cwd-'));
  process.chdir(away);
  t.after(() => process.chdir(previous));
  return away;
}

async function boot(t, box, timeoutMs = 5000) {
  const handle = await bootCell(box.spec, { root: box.root, timeoutMs, shutdownGraceMs: 80 });
  t.after(() => shutdownCell(handle));
  return handle;
}

test('cell directory resolution ignores the process working directory', async (t) => {
  const box = sandbox('noisy');
  const fromRepo = resolveDir(box.spec, box.root);

  const away = elsewhere(t);
  mkdirSync(path.join(away, 'cells', box.spec.id), { recursive: true });
  copyFileSync(fixture, path.join(away, 'cells', box.spec.id, 'noisy.mjs'));

  assert.equal(resolveDir(box.spec, box.root), fromRepo);
  assert.equal(fromRepo, box.dir);

  const handle = await boot(t, box);
  const result = await callTool(handle, 'echo', {}, 5000);
  assert.equal(result.content[0].text, `cwd:${box.dir}`);
});

test('a cell directory that does not exist names the paths tried and the root', async (t) => {
  const root = path.join(os.tmpdir(), 'protocol-absent-root');
  const spec = { id: 'hela-absent', alias: 'hela-absent', source: 'protocol-fixture', dir: 'cells/hela-absent', entry: 'main.mjs' };

  let thrown;
  try { resolveDir(spec, root); } catch (error) { thrown = error; }
  assert.ok(thrown instanceof CellDirectoryError, 'resolution throws instead of returning a guess');
  assert.equal(thrown.root, root);
  assert.match(thrown.message, /tried: /);
  assert.ok(thrown.message.includes(root), 'the message names the root it resolved from');
  assert.deepEqual(thrown.tried, [path.join(root, '..', spec.dir), path.join(root, spec.dir)]);
  for (const candidate of thrown.tried) assert.ok(thrown.message.includes(candidate), `lists ${candidate}`);

  elsewhere(t);
  await assert.rejects(bootCell(spec, { root, timeoutMs: 500 }), CellDirectoryError);
});

test('a non-JSON log line is ignored and the real response still arrives', async (t) => {
  const box = sandbox('noisy');
  const handle = await boot(t, box);
  const result = await callTool(handle, 'echo', {}, 5000);
  assert.equal(result.content[0].type, 'text');
  assert.equal(handle.protocolErrors, 0);
});

for (const [mode, label] of [['malformed', 'a response missing jsonrpc and result'], ['garbled', 'a truncated JSON-RPC frame']]) {
  test(`${label} rejects the pending call immediately`, async (t) => {
    const box = sandbox(mode);
    const handle = await boot(t, box);
    const records = [];
    const original = console.error;
    console.error = (line) => records.push(String(line));
    const started = Date.now();
    try {
      await assert.rejects(callTool(handle, 'echo', {}, 10000), CellProtocolError);
    } finally {
      console.error = original;
    }
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 2000, `rejected in ${elapsed}ms, well under the 10000ms timeout`);
    assert.equal(handle.protocolErrors, 1);
    assert.equal(records.length, 1);
    assert.match(records[0], /hela-protocol/);
    assert.ok(!handle.stopReason, 'one bad frame does not tear the cell down');
  });
}

test('a tool result that is not an MCP tool result reports the offending keys', async (t) => {
  const box = sandbox('malformed');
  const handle = await boot(t, box);
  const error = await callTool(handle, 'echo', {}, 10000).catch((e) => e);
  assert.ok(error instanceof CellProtocolError);
  assert.equal(error.name, 'CellProtocolError');
  assert.deepEqual(error.keys, ['id', 'payload']);
});
