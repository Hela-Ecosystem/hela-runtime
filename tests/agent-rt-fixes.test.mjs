// RT-03..RT-07 (hela-runtime PR #5 review follow-ups, issue #4). Needle is stubbed: the loop is under test.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { NativeNeedleAgent, avoidMutatingTools } from '../dist/agent.js';

const assetRoot = mkdtempSync(path.join(os.tmpdir(), 'hela-agent-rt-'));
mkdirSync(path.join(assetRoot, 'chaining-mcp', 'assets', 'needle'), { recursive: true });
writeFileSync(path.join(assetRoot, 'chaining-mcp', 'assets', 'needle', 'needle3'), '');
writeFileSync(path.join(assetRoot, 'chaining-mcp', 'assets', 'needle', 'needle3.cact'), '');
writeFileSync(path.join(assetRoot, 'chaining-mcp', 'assets', 'needle', 'hela-system.txt'), 'HeLa cells.\n');
test.after(() => rmSync(assetRoot, { recursive: true, force: true }));

const tool = (name, description, properties = {}, required = []) => ({
  name, cell: 'hela-fixture', realName: name, description,
  inputSchema: { type: 'object', properties, ...(required.length ? { required } : {}) },
});
const catalog = [
  tool('read_file', 'Read a file from disk.', { path: { type: 'string' } }, ['path']),
  tool('list_directory', 'List files and folders in a directory.', { path: { type: 'string' } }, ['path']),
  tool('write_file', 'Create or overwrite a file.', { path: { type: 'string' }, content: { type: 'string' } }, ['path', 'content']),
  tool('copy_file', 'Copy a file to a new location.', { source: { type: 'string' }, destination: { type: 'string' } }, ['source', 'destination']),
  tool('get_current_time', 'Get the current time in a timezone.', { timezone: { type: 'string' } }, ['timezone']),
  tool('watch_file', 'Watch a file for changes.', { path: { type: 'string' } }, ['path']),
  tool('browser_navigate', 'Open a URL in the browser.', { url: { type: 'string' } }, ['url']),
  tool('browser_screenshot', 'Take a screenshot of the current page.', {}),
];
const envelope = (value, isError) => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }], ...(isError ? { isError: true } : {}) });

function agentWith(executeAgentTool, picks, tools = catalog) {
  const host = { agentCatalog: () => tools, agentContext: () => ({ workspaceRoot: '/tmp/ws', cwd: '/tmp/cwd' }), executeAgentTool };
  const agent = new NativeNeedleAgent(host, { root: assetRoot, profile: null });
  const queue = [...picks];
  agent.choose = async () => (queue.length > 1 ? queue.shift() : queue[0]);
  agent.arguments = async (selected) => ({ args: selected.name === 'get_current_time' ? { timezone: 'Asia/Jakarta' } : selected.name === 'copy_file' ? { source: '/tmp/a.txt', destination: '/tmp/b.txt' } : selected.name === 'browser_navigate' ? { url: 'https://example.com' } : { path: '/data/x' } });
  return agent;
}

test('RT-03: a protected target does not ban the permitted copy', async () => {
  const task = 'Copy /tmp/a.txt to /tmp/b.txt without modifying the original';
  const plan = (await agentWith(async () => envelope('ok'), []).plan({ task })).plan;
  assert.deepEqual(plan.map((step) => step.tool), ['copy_file']);
  const seen = [];
  const result = await agentWith(async (selected) => { seen.push(selected.name); return envelope({ copied: true }); }, ['copy_file']).run({ task });
  assert.deepEqual(seen, ['copy_file']);
  assert.equal(result.status, 'ok');
  assert.ok(avoidMutatingTools(catalog, task).some((entry) => entry.name === 'copy_file'));
});

test('RT-03: a task-wide write ban still blocks mutating tools', async () => {
  for (const task of ['Do not modify any files. Copy nothing', 'Read notes.txt. Do not edit any files.', 'Summarise the repo and never overwrite existing files', 'List the directory without writing to disk']) {
    assert.ok(!avoidMutatingTools(catalog, task).some((entry) => entry.name === 'copy_file' || entry.name === 'write_file'), task);
  }
});

test('RT-04: a transient read timeout gets one bounded retry, a permanent error none', async () => {
  const task = 'Read notes.txt';
  let calls = 0;
  const recovered = await agentWith(async () => (++calls === 1 ? envelope({ success: false, error: 'Request timed out after 30000ms' }) : envelope('notes')), ['read_file'])
    .run({ task, maxIterations: 5, maxToolCalls: 5 });
  assert.equal(calls, 2);
  assert.equal(recovered.ok, true);
  assert.equal(recovered.status, 'degraded');
  assert.equal(recovered.failedCalls, 1);

  calls = 0;
  const stuck = await agentWith(async () => { calls++; throw new Error('ETIMEDOUT'); }, ['read_file']).run({ task, maxIterations: 8, maxToolCalls: 8 });
  assert.equal(calls, 2, 'one retry, never more');
  assert.equal(stuck.status, 'failed');
  assert.match(stuck.decision.reason, /repeated failing call skipped/);

  calls = 0;
  const permanent = await agentWith(async () => { calls++; return envelope({ success: false, error: 'ENOENT: no such file' }); }, ['read_file']).run({ task, maxIterations: 8, maxToolCalls: 8 });
  assert.equal(calls, 1);
  assert.equal(permanent.status, 'failed');
});

test('RT-04: a timed-out copy (mutating) is never retried', async () => {
  let calls = 0;
  const result = await agentWith(async () => { calls++; return envelope({ success: false, error: 'timed out' }); }, ['copy_file'])
    .run({ task: 'Copy /tmp/a.txt to /tmp/b.txt', maxIterations: 6, maxToolCalls: 6 });
  assert.equal(calls, 1);
  assert.equal(result.status, 'failed');
});

test('RT-05: a plan cut short by maxToolCalls is degraded, not ok', async () => {
  const seen = [];
  const result = await agentWith(async (selected) => { seen.push(selected.name); return envelope({ done: true }); }, ['browser_navigate', 'browser_screenshot'])
    .run({ task: 'Open https://example.com and take a screenshot', maxIterations: 6, maxToolCalls: 1 });
  assert.deepEqual(seen, ['browser_navigate']);
  assert.equal(result.ok, true);
  assert.equal(result.status, 'degraded');
  assert.ok(result.degraded.some((reason) => /pending.*screenshot/i.test(reason)), JSON.stringify(result.degraded));
  assert.deepEqual(result.pendingSteps, ['screenshot']);

  const full = await agentWith(async () => envelope({ done: true }), ['browser_navigate', 'browser_screenshot'])
    .run({ task: 'Open https://example.com and take a screenshot', maxIterations: 6, maxToolCalls: 5 });
  assert.equal(full.status, 'ok');
  assert.equal(full.pendingSteps, undefined);
});

test('RT-06: early exits report status failed', async () => {
  const agent = agentWith(async () => envelope('x'), ['read_file']);
  const missing = await agent.run({ task: '   ' });
  assert.equal(missing.ok, false);
  assert.equal(missing.status, 'failed');

  const empty = await agentWith(async () => envelope('x'), ['read_file'], []).run({ task: 'Read notes.txt' });
  assert.equal(empty.ok, false);
  assert.equal(empty.status, 'failed');

  const unhealthy = agentWith(async () => envelope('x'), ['read_file']);
  unhealthy.health = () => ({ ok: false, detail: 'engine unavailable' });
  const down = await unhealthy.run({ task: 'Read notes.txt' });
  assert.equal(down.ok, false);
  assert.equal(down.status, 'failed');

  const throwing = agentWith(async () => envelope('x'), ['read_file']);
  throwing.choose = async () => { throw new Error('planner exploded'); };
  const thrown = await throwing.run({ task: 'Read notes.txt' });
  assert.equal(thrown.ok, false);
  assert.equal(thrown.status, 'failed');
  assert.match(thrown.error, /planner exploded/);

  const plan = await agent.plan({ task: '' });
  assert.equal(plan.ok, false);
  assert.equal(plan.status, 'failed');
});
