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
