import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { HelaRuntime } from '../dist/daemon.js';
import { buildDigest } from '../dist/manifest.js';

const fixture = new URL('./fixtures/mcp-cell.mjs', import.meta.url);
const TOOLS = ['echo', 'hang', 'hold', 'crash', 'agent_run', 'fail', 'summarize', 'degrade', 'truncate'];

function sandbox() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ecosystem-pipe-'));
  mkdirSync(path.join(root, 'config'));
  const id = 'hela-fixture';
  const dir = path.join(root, 'cells', id);
  mkdirSync(dir, { recursive: true });
  copyFileSync(fixture, path.join(dir, 'normal.mjs'));
  const spec = { id, alias: id, source: 'isolated-fixture', dir: `cells/${id}`, entry: 'normal.mjs' };
  writeFileSync(path.join(root, 'config', 'inventory.json'), JSON.stringify({ inventory: { [id]: spec } }));
  writeFileSync(path.join(root, 'config', 'profiles.json'), JSON.stringify({ profiles: [{ id: 'dev-workspace', name: 'Fixture', servers: [id] }] }));
  writeFileSync(path.join(root, 'config', 'tool-catalog.json'), JSON.stringify({ format: 1, cells: { [id]: {
    digest: buildDigest(root, spec),
    variants: [{ features: {}, tools: TOOLS.map((name) => ({ name, inputSchema: { type: 'object' } })) }],
  } } }));
  return { root, specs: [spec], manifestPath: path.join(root, 'manifest.json') };
}

function events(box) {
  const file = path.join(box.root, 'cells', 'hela-fixture', 'events.jsonl');
  return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
}

async function connect(t) {
  const box = sandbox();
  const rt = new HelaRuntime({ ...box, profile: 'dev-workspace', namespaced: false, bootTimeoutMs: 500, toolTimeoutMs: 2000, shutdownGraceMs: 80 });
  t.after(() => rt.shutdown());
  const client = new Client({ name: 'pipe-contract', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await rt.server.connect(serverTransport);
  await client.connect(clientTransport);
  await rt.boot();
  return { box, client };
}

const payload = (response) => JSON.parse(response.content[0].text);

test('a failing step makes the pipe report failure and stop', { timeout: 10000 }, async (t) => {
  const { box, client } = await connect(t);
  const response = await client.callTool({
    name: 'hela.pipe',
    arguments: { steps: [
      { cell: 'hela-fixture', tool: 'echo' },
      { cell: 'hela-fixture', tool: 'fail' },
      { cell: 'hela-fixture', tool: 'summarize', args: { text: '{{prev}}' } },
    ] },
  });

  const body = payload(response);
  assert.equal(body.ok, false, 'ok must reflect the failed step');
  assert.equal(body.status, 'failed');
  assert.equal(body.failedStep, 1);
  assert.equal(body.steps, 2, 'the third step must not run when onError defaults to stop');
  assert.equal(body.results[0].ok, true);
  assert.equal(body.results[1].ok, false);
  assert.match(body.results[1].error, /boom/);
  assert.equal(response.isError, true);
  assert.ok(!events(box).some((event) => event.event === 'summarize'), 'stopped pipe must not call later steps');
});

test('a clean pipe reports status ok', { timeout: 10000 }, async (t) => {
  const { client } = await connect(t);
  const response = await client.callTool({
    name: 'hela.pipe',
    arguments: { steps: [
      { cell: 'hela-fixture', tool: 'echo' },
      { cell: 'hela-fixture', tool: 'summarize', args: { text: '{{prev}}' } },
    ] },
  });
  const body = payload(response);
  assert.equal(body.ok, true);
  assert.equal(body.status, 'ok');
  assert.equal(body.degraded, undefined);
  assert.deepEqual(body.results.map((step) => step.status), ['ok', 'ok']);
});

test('a degraded step makes the pipe report degraded, not clean success', { timeout: 10000 }, async (t) => {
  const { client } = await connect(t);
  const response = await client.callTool({
    name: 'hela.pipe',
    arguments: { steps: [
      { cell: 'hela-fixture', tool: 'degrade' },
      { cell: 'hela-fixture', tool: 'summarize', args: { text: '{{prev}}' } },
    ] },
  });
  const body = payload(response);
  assert.equal(body.ok, true, 'the step still produced a result');
  assert.equal(body.status, 'degraded', 'lossiness must be visible in the shape');
  assert.equal(response.isError, undefined);
  assert.equal(body.results[0].status, 'degraded');
  assert.deepEqual(body.degraded[0].reasons, ['two rows dropped: no id field']);
  assert.equal(body.degraded[0].step, 0);
});

test('truncated output is degraded even when the step reports ok', { timeout: 10000 }, async (t) => {
  const { client } = await connect(t);
  const response = await client.callTool({
    name: 'hela.pipe',
    arguments: { steps: [{ cell: 'hela-fixture', tool: 'truncate' }] },
  });
  const body = payload(response);
  assert.equal(body.status, 'degraded');
  assert.deepEqual(body.degraded[0].reasons, ['truncated']);
});

test('onError=continue never pipes a failure payload onward as data', { timeout: 10000 }, async (t) => {
  const { client } = await connect(t);
  const response = await client.callTool({
    name: 'hela.pipe',
    arguments: {
      onError: 'continue',
      steps: [
        { cell: 'hela-fixture', tool: 'fail' },
        { cell: 'hela-fixture', tool: 'summarize', args: { text: '{{prev}}' } },
      ],
    },
  });

  const body = payload(response);
  assert.equal(body.ok, false, 'a failed step keeps ok false even when continuing');
  assert.equal(body.failedStep, 0);
  assert.equal(body.steps, 2, 'continue runs the remaining steps');
  assert.equal(body.results[1].ok, true);
  const inner = JSON.parse(body.results[1].result.content[0].text);
  assert.equal(inner.got, null, `error text leaked into the next step: ${JSON.stringify(inner)}`);
});

test('a successful chain pipes the parsed payload and reports ok', { timeout: 10000 }, async (t) => {
  const { client } = await connect(t);
  const response = await client.callTool({
    name: 'hela.pipe',
    arguments: { steps: [
      { cell: 'hela-fixture', tool: 'echo' },
      { cell: 'hela-fixture', tool: 'summarize', args: { text: '{{prev}}' } },
    ] },
  });

  const body = payload(response);
  assert.equal(body.ok, true);
  assert.equal(body.steps, 2);
  assert.equal(response.isError, undefined);
  assert.ok(body.results.every((step) => step.ok === true));
  const summarized = JSON.parse(body.results[1].result.content[0].text);
  const echoPayload = JSON.parse(body.results[0].result.content[0].text);
  assert.deepEqual(JSON.parse(summarized.got), echoPayload, 'the next step receives the previous payload, not the envelope');
});
