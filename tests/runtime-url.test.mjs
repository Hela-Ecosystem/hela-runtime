import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { HelaRuntime } from '../dist/daemon.js';
import { buildDigest } from '../dist/manifest.js';

const fixture = new URL('./fixtures/url-cell.mjs', import.meta.url);

function sandbox(id) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ecosystem-url-'));
  mkdirSync(path.join(root, 'config'));
  const dir = path.join(root, 'cells', id);
  mkdirSync(dir, { recursive: true });
  copyFileSync(fixture, path.join(dir, 'main.mjs'));
  const spec = { id, alias: id, source: 'isolated-fixture', dir: `cells/${id}`, entry: 'main.mjs' };
  writeFileSync(path.join(root, 'config', 'inventory.json'), JSON.stringify({ inventory: { [id]: spec } }));
  writeFileSync(path.join(root, 'config', 'profiles.json'), JSON.stringify({ profiles: [{ id: 'dev-workspace', name: 'Fixture', servers: [id] }] }));
  writeFileSync(path.join(root, 'config', 'tool-catalog.json'), JSON.stringify({ format: 1, cells: { [id]: {
    digest: buildDigest(root, spec),
    variants: [{ features: {}, tools: [{ name: 'runtime_url', inputSchema: { type: 'object' } }] }],
  } } }));
  return { root, specs: [spec], manifestPath: path.join(root, 'manifest.json') };
}

async function cellUrl(t, id) {
  const rt = new HelaRuntime({ ...sandbox(id), profile: 'dev-workspace', namespaced: false, bootTimeoutMs: 5000, toolTimeoutMs: 5000, shutdownGraceMs: 80 });
  let shut = false;
  const stop = async () => { if (!shut) { shut = true; await rt.shutdown(); } };
  t.after(stop);
  const client = new Client({ name: 'runtime-url', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await rt.server.connect(serverTransport);
  await client.connect(clientTransport);
  await rt.boot();
  const response = await client.callTool({ name: 'runtime_url', arguments: {} });
  return { url: response.content[0].text, stop };
}

const initialize = (url) => fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'probe', version: '1.0.0' } } }),
});

test('the Mitosis cell is given a loopback capability URL that really serves MCP', async (t) => {
  const previous = process.env.HELA_RUNTIME_URL;
  delete process.env.HELA_RUNTIME_URL;
  t.after(() => { if (previous !== undefined) process.env.HELA_RUNTIME_URL = previous; });

  const { url, stop } = await cellUrl(t, 'hela-mitosis');
  const parsed = new URL(url);
  assert.equal(parsed.hostname, '127.0.0.1');
  assert.match(parsed.pathname, /^\/mcp\/[0-9a-f]{32}$/);

  assert.equal((await initialize(url)).status, 200);
  assert.equal((await initialize(`${parsed.origin}/mcp`)).status, 404, 'the plain /mcp path is not served without the secret');
  assert.equal((await initialize(`${parsed.origin}/`)).status, 404);

  await stop();
  await assert.rejects(initialize(url), 'the endpoint closes with the runtime');
});

test('other cells do not receive the endpoint, and an operator-set URL wins', async (t) => {
  const previous = process.env.HELA_RUNTIME_URL;
  delete process.env.HELA_RUNTIME_URL;
  t.after(() => { if (previous === undefined) delete process.env.HELA_RUNTIME_URL; else process.env.HELA_RUNTIME_URL = previous; });

  assert.equal((await cellUrl(t, 'hela-other')).url, 'unset');

  process.env.HELA_RUNTIME_URL = 'http://127.0.0.1:9/mcp';
  assert.equal((await cellUrl(t, 'hela-mitosis')).url, 'http://127.0.0.1:9/mcp');
});
