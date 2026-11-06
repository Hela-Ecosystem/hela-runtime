import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { bootCell, callTool, CellTimeoutError, shutdownCell } from '../dist/cell-loader.js';
import { HelaRuntime } from '../dist/daemon.js';
import { buildDigest, ManifestStore } from '../dist/manifest.js';

const fixture = new URL('./fixtures/mcp-cell.mjs', import.meta.url);
const sandboxes = [];

function sandbox(mode = 'normal', ids = ['hela-fixture']) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ecosystem-'));
  mkdirSync(path.join(root, 'config'));
  const specs = ids.map((id) => {
    const dir = path.join(root, 'cells', id);
    mkdirSync(dir, { recursive: true });
    copyFileSync(fixture, path.join(dir, `${mode}.mjs`));
    return { id, alias: id, source: 'isolated-fixture', dir: `cells/${id}`, entry: `${mode}.mjs` };
  });
  writeFileSync(path.join(root, 'config', 'inventory.json'), JSON.stringify({ inventory: Object.fromEntries(specs.map((s) => [s.id, s])) }));
  writeFileSync(path.join(root, 'config', 'profiles.json'), JSON.stringify({ profiles: [{ id: 'dev-workspace', servers: ids }] }));
  writeFileSync(path.join(root, 'config', 'tool-catalog.json'), JSON.stringify({ format: 1, cells: Object.fromEntries(specs.map((spec, index) => [spec.id, {
    digest: buildDigest(root, spec), variants: [{ features: {}, tools: (index === 0 ? ['echo', 'hang', 'hold', 'crash', 'agent_run'] : [])
      .map(name => ({ name, inputSchema: { type: 'object' } })) }],
  }])) }));
  const box = { root, specs, manifestPath: path.join(root, 'manifest.json') };
  sandboxes.push(box);
  return box;
}

function events(box, id = box.specs[0].id) {
  const file = path.join(box.root, 'cells', id, 'events.jsonl');
  return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
}

async function until(predicate, label, timeoutMs = 5000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const result = predicate();
    if (result) return result;
    await sleep(10);
  }
  assert.fail(`Timed out waiting for ${label}`);
}

function assertGone(pid) {
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
}

async function connectRuntime(t, box, overrides = {}) {
  const rt = new HelaRuntime({ ...box, bootTimeoutMs: 500, toolTimeoutMs: 100, agentTimeoutMs: 100, shutdownGraceMs: 80, restartDelayMs: 40, ...overrides });
  t.after(() => rt.shutdown());
  const client = new Client({ name: 'isolated-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await rt.server.connect(serverTransport);
  await client.connect(clientTransport);
  await rt.boot();
  return { box, rt, client };
}

async function runtime(t, mode = 'normal', overrides = {}, ids) {
  return connectRuntime(t, sandbox(mode, ids), overrides);
}

test('test runner removes inherited environment hooks and credentials', () => {
  assert.deepEqual(Object.keys(process.env).filter((key) => key !== 'NODE_TEST_CONTEXT').sort(), ['HOME', 'PATH', 'TMPDIR', 'XDG_CACHE_HOME']);
});

test('loader timeout rejects all pending RPCs; SIGTERM escalates to SIGKILL and reaps actual PID', { timeout: 10000 }, async (t) => {
  const box = sandbox();
  const handle = await bootCell(box.specs[0], { root: box.root, timeoutMs: 1000, shutdownGraceMs: 80 });
  t.after(() => shutdownCell(handle));
  const pid = handle.proc.pid;
  const held = assert.rejects(callTool(handle, 'hold', {}, 5000), CellTimeoutError);
  await assert.rejects(callTool(handle, 'hang', {}, 100), CellTimeoutError);
  await held;
  assert.equal(handle.ready, false);
  assert.equal(handle.stopReason, 'timeout');
  assert.equal(handle.proc.killed, true);
  await until(() => events(box).some((e) => e.event === 'SIGTERM'), 'SIGTERM receipt');
  await handle.exited;
  assert.equal(handle.proc.signalCode, 'SIGKILL');
  assertGone(pid);
  assert.equal(events(box).filter((e) => e.event === 'SIGTERM').length, 1);
  await shutdownCell(handle);
  t.diagnostic(`loader PID ${pid}: timeout -> SIGTERM -> SIGKILL -> ESRCH`);
});

for (const route of ['plain', 'namespaced', 'pipe', 'agent-alias']) {
  test(`${route}: timeout result, one restart, supervisor survives and tool succeeds with new PID`, { timeout: 10000 }, async (t) => {
    const id = route === 'agent-alias' ? 'hela-mitosis' : 'hela-fixture';
    const { box, rt, client } = await runtime(t, 'normal', { namespaced: route === 'namespaced' }, [id]);
    assert.equal(rt.profile, 'dev-workspace');
    assert.equal(rt.namespaced, route === 'namespaced');
    const old = await rt.ensureCell(id);
    assert.ok(old?.ready);
    const prefix = route === 'namespaced' ? 'hela_fixture_' : '';
    const before = await client.callTool({ name: `${prefix}echo` });
    assert.equal(JSON.parse(before.content[0].text).pid, old.proc.pid);
    const response = await client.callTool(route === 'pipe'
      ? { name: 'hela.pipe', arguments: { steps: [{ cell: id, tool: 'hang' }] } }
      : route === 'agent-alias' ? { name: 'hela.agent.run', arguments: { hang: true } }
        : { name: `${prefix}hang` });
    assert.equal(response.isError, true);
    assert.match(response.content[0].text, /timeout after 100ms/);
    await old.exited;
    assert.equal(old.proc.signalCode, 'SIGKILL');
    assertGone(old.proc.pid);
    assert.equal(events(box).filter((e) => e.pid === old.proc.pid && e.event === 'SIGTERM').length, 1);
    assert.ok(events(box).some((e) => e.pid === old.proc.pid && e.event === (route === 'agent-alias' ? 'agent_run' : 'hang')));
    const fresh = await until(() => {
      const cell = rt.cells.get(id);
      return cell?.ready && cell !== old ? cell : undefined;
    }, 'replacement cell');
    assert.notEqual(fresh.proc.pid, old.proc.pid);
    assert.equal(rt.restartAttempts.get(id), 1);
    const after = await client.callTool({ name: `${prefix}echo` });
    assert.equal(JSON.parse(after.content[0].text).pid, fresh.proc.pid);
    assert.equal(events(box).filter((e) => e.event === 'spawn').length, 2);
    t.diagnostic(`${route} PID ${old.proc.pid} -> ${fresh.proc.pid}; timeout result, SIGTERM/SIGKILL, echo succeeded`);
    await rt.shutdown();
    assertGone(fresh.proc.pid);
    assert.equal(fresh.stopReason, 'shutdown');
  });
}

test('crash promptly rejects pending RPCs and concurrent ensure calls cannot duplicate restart', { timeout: 10000 }, async (t) => {
  const { box, rt, client } = await runtime(t, 'normal', { toolTimeoutMs: 5000, restartDelayMs: 100 });
  const old = await rt.ensureCell('hela-fixture');
  const held = client.callTool({ name: 'hold' });
  const crash = client.callTool({ name: 'crash' });
  assert.match((await held).content[0].text, /exited/);
  assert.match((await crash).content[0].text, /exited/);
  assert.equal(old.stopReason, undefined);
  assertGone(old.proc.pid);
  await Promise.all(Array.from({ length: 10 }, () => rt.ensureCell('hela-fixture')));
  const fresh = await until(() => rt.cells.get('hela-fixture')?.ready && rt.cells.get('hela-fixture') !== old, 'crash restart');
  assert.ok(fresh);
  assert.equal(rt.restartAttempts.get('hela-fixture'), 1);
  assert.equal(events(box).filter((e) => e.event === 'spawn').length, 2);
});

test('shutdown rejects pending RPC, reaps SIGTERM-resistant child, and never restarts', { timeout: 10000 }, async (t) => {
  const { box, rt, client } = await runtime(t, 'normal', { toolTimeoutMs: 5000 });
  const handle = await rt.ensureCell('hela-fixture');
  const held = client.callTool({ name: 'hold' }).catch((error) => error);
  await until(() => events(box).some((e) => e.event === 'hold'), 'pending RPC');
  const shutdown = rt.shutdown();
  assert.equal(rt.shutdown(), shutdown);
  await shutdown;
  await held;
  assert.equal(handle.stopReason, 'shutdown');
  assert.equal(handle.proc.signalCode, 'SIGKILL');
  assertGone(handle.proc.pid);
  await sleep(150);
  assert.equal(events(box).filter((e) => e.event === 'spawn').length, 1);
  assert.equal(rt.restartAttempts.size, 0);
  assert.equal(await rt.ensureCell('hela-fixture'), undefined);
});

test('shutdown cancels queued crash restart', { timeout: 10000 }, async (t) => {
  const { box, rt, client } = await runtime(t, 'normal', { restartDelayMs: 200 });
  const handle = await rt.ensureCell('hela-fixture');
  await client.callTool({ name: 'crash' });
  await handle.exited;
  assert.equal(rt.restartAttempts.get('hela-fixture'), 1);
  await rt.shutdown();
  await sleep(250);
  assert.equal(events(box).filter((e) => e.event === 'spawn').length, 1);
});

test('uninvoked cells never start in the background', { timeout: 10000 }, async (t) => {
  const { box, rt } = await runtime(t, 'normal', {}, ['hela-a', 'hela-b', 'hela-c']);
  await sleep(450);
  assert.equal(rt.cells.size, 0);
  await rt.shutdown();
  await rt.boot();
  await sleep(450);
  for (const spec of box.specs) assert.deepEqual(events(box, spec.id), []);
  assert.equal(rt.cells.size, 0);
});

test('shutdown aborts and reaps in-flight initialization without a late boot', { timeout: 10000 }, async (t) => {
  const { box, rt } = await runtime(t, 'boot-hang', { bootTimeoutMs: 5000 });
  const boot = rt.ensureCell('hela-fixture');
  const started = await until(() => events(box).find((e) => e.event === 'initialize'), 'initialization');
  await rt.shutdown();
  assert.equal(await boot, undefined);
  assertGone(started.pid);
  assert.equal(events(box).filter((e) => e.event === 'SIGTERM').length, 1);
  assert.equal(rt.cells.size, 0);
  assert.equal(rt.booting.size, 0);
  assert.equal(rt.restartAttempts.size, 0);
  await sleep(150);
  assert.equal(events(box).filter((e) => e.event === 'spawn').length, 1);
});

for (const mode of ['boot-hang', 'boot-fail', 'crash-loop']) {
  test(`${mode}: initial boot plus exactly three bounded retries, all children reaped`, { timeout: 10000 }, async (t) => {
    const { box, rt } = await runtime(t, mode, { restartDelayMs: 20 });
    void rt.ensureCell('hela-fixture');
    await until(() => rt.deadCells.has('hela-fixture'), 'retry exhaustion');
    assert.equal(rt.restartAttempts.get('hela-fixture'), 3);
    const started = events(box).filter((e) => e.event === 'spawn');
    assert.equal(started.length, 4);
    for (const { pid } of started) assertGone(pid);
    if (mode !== 'crash-loop') assert.equal(events(box).filter((e) => e.event === 'SIGTERM').length, 4);
    await Promise.all(Array.from({ length: 10 }, () => rt.ensureCell('hela-fixture')));
    await sleep(200);
    assert.equal(events(box).filter((e) => e.event === 'spawn').length, 4);
    assert.equal(rt.cells.size, 0);
    t.diagnostic(`${mode}: ${started.map((e) => e.pid).join(', ')} all ESRCH; retry count=3`);
  });
}

test('spawn failure rejects without leaving a boot or shutdown timer hanging', { timeout: 3000 }, async () => {
  await assert.rejects(bootCell({ id: 'missing', alias: 'missing', source: 'fixture', dir: 'missing', entry: 'missing.mjs' }, { root: path.join(os.tmpdir(), 'nonexistent-fixture-root'), timeoutMs: 1000 }), /ENOENT/);
});

for (const namespaced of [false, true]) {
  test(`warm cache cannot advertise or invoke out-of-profile cells (namespaced=${namespaced})`, { timeout: 10000 }, async (t) => {
    const box = sandbox('normal', ['hela-fixture', 'hela-outside', 'hela-mitosis']);
    writeFileSync(path.join(box.root, 'config', 'profiles.json'), JSON.stringify({ profiles: [{ id: 'dev-workspace', servers: ['hela-fixture'] }] }));
    const tool = (name) => ({ name, inputSchema: { type: 'object' } });
    writeFileSync(box.manifestPath, JSON.stringify({
      'hela-fixture': [tool('echo')],
      'hela-outside': [tool('forbidden_tool')],
      'hela-mitosis': [tool('agent_run')],
      'hela-ghost': [tool('ghost_tool')],
    }));
    const store = new ManifestStore(box.manifestPath, box.root, 'dev-workspace', namespaced);
    for (const spec of box.specs) {
      store.save(spec.id, store.identity({ ...spec, env: [], lazy: false }).fingerprint,
        [tool(spec.id === 'hela-fixture' ? 'echo' : spec.id === 'hela-outside' ? 'forbidden_tool' : 'agent_run')]);
    }
    const { rt, client } = await connectRuntime(t, box, { namespaced });
    assert.deepEqual([...rt.specs.keys()], ['hela-fixture']);
    assert.deepEqual([...rt.lazyCells], ['hela-fixture']);
    const listed = (await client.listTools()).tools.map((entry) => entry.name);
    assert.ok(listed.includes(namespaced ? 'hela_fixture_echo' : 'echo'));
    assert.ok(!listed.some((name) => /forbidden|ghost|hela\.agent\.run|hela_mitosis_/.test(name)));
    for (const name of [namespaced ? 'hela_outside_forbidden_tool' : 'forbidden_tool', namespaced ? 'hela_ghost_ghost_tool' : 'ghost_tool', 'hela.agent.run']) {
      await assert.rejects(client.callTool({ name }), /Unknown tool/);
    }
    const piped = await client.callTool({ name: 'hela.pipe', arguments: { steps: [{ cell: 'hela-outside', tool: 'echo' }] } });
    assert.equal(piped.isError, true);
    assert.match(piped.content[0].text, /not in the selected profile/);
    assert.equal(await rt.ensureCell('hela-outside'), undefined);
    assert.equal(await rt.ensureCell('hela-mitosis'), undefined);
    assert.equal(await rt.ensureCell('hela-ghost'), undefined);
    const response = await client.callTool({ name: namespaced ? 'hela_fixture_echo' : 'echo' });
    assert.equal(response.isError, undefined);
    assert.deepEqual([...rt.cells.keys()], ['hela-fixture']);
    assert.deepEqual(events(box, 'hela-outside'), []);
    assert.deepEqual(events(box, 'hela-mitosis'), []);
  });
}

test('unknown profile fails closed before any background startup', { timeout: 3000 }, async (t) => {
  const box = sandbox();
  const rt = new HelaRuntime({ ...box, profile: 'typo' });
  t.after(() => rt.shutdown());
  await assert.rejects(rt.boot(), /Unknown profile: typo/);
  assert.equal(rt.specs.size, 0);
  assert.equal(rt.lazyCells.size, 0);
  await sleep(50);
  assert.deepEqual(events(box), []);
});

test('explicit all-cells mode supports standalone inventories without profiles', { timeout: 3000 }, async (t) => {
  const box = sandbox();
  unlinkSync(path.join(box.root, 'config', 'profiles.json'));
  const { rt, client } = await connectRuntime(t, box, { profile: null });
  assert.equal(rt.profile, null);
  const response = await client.callTool({ name: 'echo' });
  assert.equal(response.isError, undefined);
  assert.deepEqual([...rt.specs.keys()], ['hela-fixture']);
});

for (const namespaced of [false, true]) {
  test(`cold discovery and concurrent first calls stay truly lazy; warm cache works (namespaced=${namespaced})`, { timeout: 10000 }, async (t) => {
    const box = sandbox('normal', ['hela-fixture', 'hela-unused']);
    const { rt, client } = await connectRuntime(t, box, { namespaced, bootTimeoutMs: 1000 });
    await sleep(250);
    const listed = (await client.listTools()).tools;
    assert.equal(rt.manifestSources.get('hela-fixture'), 'catalog');
    assert.equal(rt.cells.size, 0);
    assert.deepEqual(events(box), []);
    const name = namespaced ? 'hela_fixture_echo' : 'echo';
    assert.ok(listed.some(tool => tool.name === name));
    for (const unknown of ['missing_tool', namespaced ? 'echo' : 'hela_fixture_echo']) {
      await assert.rejects(client.callTool({ name: unknown }), /Unknown tool/);
    }
    assert.equal(rt.cells.size, 0);
    const coldStart = performance.now();
    const responses = await Promise.all(Array.from({ length: 24 }, () => client.callTool({ name })));
    const coldMs = performance.now() - coldStart;
    assert.ok(responses.every(response => !response.isError));
    assert.equal(new Set(responses.map(response => JSON.parse(response.content[0].text).pid)).size, 1);
    assert.equal(events(box).filter(event => event.event === 'spawn').length, 1);
    assert.deepEqual(events(box, 'hela-unused'), []);
    const warmStart = performance.now();
    await client.callTool({ name });
    t.diagnostic(`cold/concurrent=${coldMs.toFixed(2)}ms warm=${(performance.now() - warmStart).toFixed(2)}ms boot=${rt.cellStartupMs.get('hela-fixture').toFixed(2)}ms`);
    await rt.shutdown();
    const warm = await connectRuntime(t, box, { namespaced });
    assert.equal(warm.rt.manifestSources.get('hela-fixture'), 'cache');
    assert.equal(warm.rt.cells.size, 0);
    await warm.client.callTool({ name });
    assert.equal(events(box).filter(event => event.event === 'spawn').length, 2);
  });
}

for (const change of ['revision', 'version', 'build', 'environment', 'features']) {
  test(`manifest cache invalidates on ${change} without stale advertisement or eager startup`, { timeout: 10000 }, async (t) => {
    const box = sandbox();
    const inherited = process.env.TODO103_FIXTURE_OPTION;
    t.after(() => {
      if (inherited === undefined) delete process.env.TODO103_FIXTURE_OPTION;
      else process.env.TODO103_FIXTURE_OPTION = inherited;
    });
    const inventoryFile = path.join(box.root, 'config/inventory.json');
    const inventory = JSON.parse(readFileSync(inventoryFile, 'utf8'));
    const spec = inventory.inventory['hela-fixture'];
    spec.env = ['TODO103_FIXTURE_OPTION'];
    writeFileSync(inventoryFile, JSON.stringify(inventory));
    const first = await connectRuntime(t, box);
    await first.client.callTool({ name: 'echo' });
    await first.rt.shutdown();
    if (change === 'revision') spec.revision = 'changed-revision';
    if (change === 'version') spec.version = '99.0.0';
    if (change === 'build') {
      const file = path.join(box.root, spec.dir, spec.entry);
      writeFileSync(file, readFileSync(file, 'utf8') + '\nvoid 0;\n');
    }
    if (change === 'environment') process.env.TODO103_FIXTURE_OPTION = 'synthetic-value-must-not-be-persisted';
    if (change === 'features') spec.toolFeatures = { TODO103_FIXTURE_ENABLED: { default: true } };
    writeFileSync(inventoryFile, JSON.stringify(inventory));
    const second = await connectRuntime(t, box);
    assert.notEqual(second.rt.manifestSources.get(spec.id), 'cache');
    assert.equal(second.rt.cells.size, 0);
    if (change !== 'environment') {
      const tools = (await second.client.listTools()).tools;
      assert.deepEqual(tools.map(tool => tool.name), ['hela.pipe']);
      await assert.rejects(second.client.callTool({ name: 'echo' }), /Unknown tool/);
      assert.equal(events(box).filter(event => event.event === 'spawn').length, 1);
    } else {
      assert.equal(second.rt.manifestSources.get(spec.id), 'catalog');
      await second.client.callTool({ name: 'echo' });
      assert.ok(!readFileSync(box.manifestPath, 'utf8').includes('synthetic-value-must-not-be-persisted'));
    }
  });
}

test('switching profiles, roots, and namespace modes cannot reuse another cache identity', { timeout: 10000 }, async (t) => {
  const box = sandbox();
  const profiles = { profiles: [
    { id: 'dev-workspace', servers: ['hela-fixture'] },
    { id: 'minimal', servers: ['hela-fixture'] },
  ] };
  writeFileSync(path.join(box.root, 'config/profiles.json'), JSON.stringify(profiles));
  const initial = await connectRuntime(t, box);
  await initial.client.callTool({ name: 'echo' });
  await initial.rt.shutdown();
  for (const overrides of [{ profile: 'minimal' }, { namespaced: true }]) {
    const next = await connectRuntime(t, box, overrides);
    assert.equal(next.rt.manifestSources.get('hela-fixture'), 'catalog');
    assert.equal(next.rt.cells.size, 0);
    await next.rt.shutdown();
  }
  const other = sandbox();
  const next = await connectRuntime(t, { ...other, manifestPath: box.manifestPath });
  assert.equal(next.rt.manifestSources.get('hela-fixture'), 'catalog');
  assert.equal(next.rt.cells.size, 0);
});

for (const content of ['{"hela-fixture":[{"name":"obsolete"}]}', '{broken', '{"format":2,"profiles":null}']) {
  test(`legacy or corrupt caches recover from the catalog (${content.length} bytes)`, async (t) => {
    const box = sandbox();
    writeFileSync(box.manifestPath, content);
    const { rt, client } = await connectRuntime(t, box);
    assert.equal(rt.manifestSources.get('hela-fixture'), 'catalog');
    assert.ok(!(await client.listTools()).tools.some(tool => tool.name === 'obsolete'));
    assert.deepEqual(events(box), []);
  });
}

test('missing catalog is explicit and pipe can discover only its named cell on demand', async (t) => {
  const box = sandbox('normal', ['hela-fixture', 'hela-unused']);
  unlinkSync(path.join(box.root, 'config/tool-catalog.json'));
  const { rt, client } = await connectRuntime(t, box);
  assert.equal(rt.manifestSources.get('hela-fixture'), 'missing');
  assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), ['hela.pipe']);
  await assert.rejects(client.callTool({ name: 'echo' }), /Unknown tool/);
  assert.equal(rt.cells.size, 0);
  const response = await client.callTool({ name: 'hela.pipe', arguments: { steps: [{ cell: 'hela-fixture', tool: 'echo' }] } });
  assert.equal(response.isError, undefined);
  assert.deepEqual([...rt.cells.keys()], ['hela-fixture']);
  assert.deepEqual(events(box, 'hela-unused'), []);
  assert.ok((await client.listTools()).tools.some(tool => tool.name === 'echo'));
});

test('all fixture PIDs are reaped and default manifest cache remains untouched', (t) => {
  let count = 0;
  for (const box of sandboxes) {
    for (const spec of box.specs) {
      for (const event of events(box, spec.id).filter((e) => e.event === 'spawn')) {
        assertGone(event.pid);
        count++;
      }
    }
  }
  assert.equal(existsSync(path.join(os.homedir(), '.cache', 'hela-runtime')), false);
  t.diagnostic(`${count} fixture PIDs verified ESRCH; no default cache writes`);
});
