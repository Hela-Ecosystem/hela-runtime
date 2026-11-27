// chaining-mcp#30: passive mode for external DAG coordinators, runtime side.
import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { HelaRuntime } from '../dist/daemon.js';
import { buildDigest } from '../dist/manifest.js';
import { isCellToolAllowed, orchestratorMode, passiveRefusal } from '../dist/orchestrator-mode.js';

const fixture = new URL('./fixtures/passive-cell.mjs', import.meta.url);
const ALLOWED = ['analyze_tools', 'get_current_time', 'validate_tool_chain', 'search_skills', 'llm_query'];
const OMITTED = ['agent_run', 'workflow_orchestrator', 'workflow_status', 'sequentialthinking', 'brainstorming', 'llm_suggest_route'];
const TOOLS = [...ALLOWED, ...OMITTED];

function sandbox({ needle }) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ecosystem-passive-'));
  mkdirSync(path.join(root, 'config'));
  const specs = ['hela-mitosis', 'hela-membrane'].map((id) => {
    const dir = path.join(root, 'cells', id);
    mkdirSync(dir, { recursive: true });
    copyFileSync(fixture, path.join(dir, 'main.mjs'));
    return { id, alias: id, source: 'isolated-fixture', dir: `cells/${id}`, entry: 'main.mjs' };
  });
  writeFileSync(path.join(root, 'config', 'inventory.json'), JSON.stringify({ inventory: Object.fromEntries(specs.map((spec) => [spec.id, spec])) }));
  writeFileSync(path.join(root, 'config', 'profiles.json'), JSON.stringify({ profiles: [{ id: 'dev-workspace', name: 'Fixture', servers: specs.map((spec) => spec.id) }] }));
  // Only Mitosis has a catalog entry, with the full autonomous surface; membrane is discovered live.
  writeFileSync(path.join(root, 'config', 'tool-catalog.json'), JSON.stringify({ format: 1, cells: { 'hela-mitosis': {
    digest: buildDigest(root, specs[0]),
    variants: [{ features: {}, tools: TOOLS.map((name) => ({ name, inputSchema: { type: 'object' } })) }],
  } } }));
  const marker = path.join(root, 'engine-started');
  if (needle) {
    const assets = path.join(root, 'chaining-mcp', 'assets', 'needle');
    mkdirSync(assets, { recursive: true });
    for (const name of ['needle3', 'needle3.cact', 'hela-system.txt']) writeFileSync(path.join(assets, name), name === 'needle3' ? `#!/bin/sh\ntouch '${marker}'\n` : 'x');
    chmodSync(path.join(assets, 'needle3'), 0o755);
  }
  return { root, specs, manifestPath: path.join(root, 'manifest.json'), marker };
}

function setEnv(t, values) {
  const saved = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  const apply = (entries) => {
    for (const [key, value] of Object.entries(entries)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  };
  apply(values);
  t.after(() => apply(saved));
}

async function start(t, box, namespaced) {
  const rt = new HelaRuntime({ root: box.root, specs: box.specs, manifestPath: box.manifestPath, profile: 'dev-workspace', namespaced, bootTimeoutMs: 5000, toolTimeoutMs: 5000, shutdownGraceMs: 80 });
  const stop = () => rt.shutdown();
  t.after(stop);
  const client = new Client({ name: 'runtime-passive', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await rt.server.connect(serverTransport);
  await client.connect(clientTransport);
  await rt.boot();
  const names = async () => (await client.listTools()).tools.map((tool) => tool.name);
  const call = async (name, args = {}) => {
    const response = await client.callTool({ name, arguments: args });
    return { isError: response.isError === true, body: JSON.parse(response.content[0].text) };
  };
  return { rt, names, call, stop };
}

const exposed = (namespaced, cell, name) => (namespaced ? `hela_${cell}_${name}` : name);

test('mode resolution and allow-list', () => {
  for (const value of [undefined, '', '  ']) assert.equal(orchestratorMode({ MITOSIS_EXTERNAL_ORCHESTRATOR: value }).passive, false);
  const env = { MITOSIS_EXTERNAL_ORCHESTRATOR: ' meta7 ' };
  assert.deepEqual(orchestratorMode(env), { passive: true, externalOrchestrator: 'meta7' });
  assert.equal(isCellToolAllowed('hela-mitosis', 'some_future_tool', env), false);
  assert.equal(isCellToolAllowed('hela-membrane', 'brainstorming', env), true);
  assert.equal(isCellToolAllowed('hela-mitosis', 'llm_query', { ...env, CHAINING_LLM_ENABLED: 'false' }), false);
  assert.equal(passiveRefusal('brainstorming', 'hela-membrane', env), null, 'another cell owns the name');
  assert.equal(passiveRefusal('hela.pipe', undefined, {}), null);
});

for (const namespaced of [true, false]) {
  for (const needle of [true, false]) {
    test(`passive surface and refusals (namespaced=${namespaced}, needle assets=${needle})`, async (t) => {
      setEnv(t, { MITOSIS_EXTERNAL_ORCHESTRATOR: 'meta7', CHAINING_LLM_ENABLED: undefined, HELA_RUNTIME_URL: undefined, HELA_NATIVE_AGENT: undefined, HELA_HTTP_PORT: undefined, FIXTURE_TOOLS: JSON.stringify(TOOLS) });
      const box = sandbox({ needle });
      t.after(() => rmSync(box.root, { recursive: true, force: true }));
      const { names, call, stop } = await start(t, box, namespaced);
      const listed = await names();
      for (const name of ALLOWED) assert.ok(listed.includes(exposed(namespaced, 'mitosis', name)), name);
      for (const name of ['hela.agent.run', 'hela.pipe', ...OMITTED.map((name) => exposed(namespaced, 'mitosis', name))]) {
        // membrane is not Mitosis: with bare names its same-named fixture tools stay listed.
        if (!namespaced && OMITTED.includes(name)) continue;
        assert.ok(!listed.includes(name), `${name} advertised`);
      }
      const refused = ['hela.agent.run', 'hela.pipe', ...(namespaced ? OMITTED.map((name) => `hela_mitosis_${name}`) : ['agent_run'])];
      for (const name of refused) {
        const result = await call(name, { task: 'x', steps: [{ cell: 'hela-membrane', tool: 'analyze_tools' }] });
        assert.equal(result.isError, true, name);
        assert.deepEqual([result.body.code, result.body.externalOrchestrator, result.body.tool], ['MITOSIS_PASSIVE_MODE', 'meta7', name]);
      }
      const ran = await call(exposed(namespaced, 'mitosis', 'get_current_time'));
      assert.deepEqual(ran.body, { ran: 'get_current_time', runtimeUrl: null });
      if (needle) {
        const found = (await call('hela.catalog.list', { cell: 'hela-mitosis' })).body.tools.map((tool) => tool.name);
        // The agent catalog already leaves some utilities out; what matters is that nothing omitted shows up.
        const bare = found.map((name) => name.replace('hela_mitosis_', '')).sort();
        assert.deepEqual(bare, ['get_current_time', 'search_skills']);
      }
      // The booted cell advertised everything; the live manifest must be filtered too.
      const live = await names();
      if (namespaced) assert.ok(!OMITTED.some((name) => live.includes(`hela_mitosis_${name}`)));
      assert.ok(!existsSync(box.marker), 'the Needle engine was started');
      await stop();
    });
  }
}

test('toggling the variable over one manifest cache always follows the current mode', async (t) => {
  setEnv(t, { MITOSIS_EXTERNAL_ORCHESTRATOR: undefined, HELA_RUNTIME_URL: undefined, HELA_HTTP_PORT: undefined, FIXTURE_TOOLS: JSON.stringify(TOOLS) });
  const box = sandbox({ needle: false });
  t.after(() => rmSync(box.root, { recursive: true, force: true }));
  for (const mode of [undefined, 'passive', undefined, 'passive']) {
    if (mode) process.env.MITOSIS_EXTERNAL_ORCHESTRATOR = mode; else delete process.env.MITOSIS_EXTERNAL_ORCHESTRATOR;
    const { names, call, stop } = await start(t, box, true);
    const check = async (when) => {
      const listed = await names();
      assert.equal(listed.includes('hela_mitosis_workflow_orchestrator'), !mode, `${mode} ${when}`);
      assert.equal(listed.includes('hela.pipe'), !mode, `${mode} ${when}`);
      assert.ok(listed.includes('hela_mitosis_get_current_time'));
    };
    await check('before boot');
    await call('hela_mitosis_get_current_time'); // boots the cell, which saves a live manifest
    await check('after boot');
    await stop();
  }
});
