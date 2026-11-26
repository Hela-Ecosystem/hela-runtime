// RT-08 (runtime#4), RT-09 (runtime#8), RT-10 (runtime#9). Needle is stubbed: retrieval and the loop are under test.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { NativeNeedleAgent, repairArgs } from '../dist/agent.js';

const assetRoot = mkdtempSync(path.join(os.tmpdir(), 'hela-agent-rt0810-'));
mkdirSync(path.join(assetRoot, 'chaining-mcp', 'assets', 'needle'), { recursive: true });
writeFileSync(path.join(assetRoot, 'chaining-mcp', 'assets', 'needle', 'needle3'), '');
writeFileSync(path.join(assetRoot, 'chaining-mcp', 'assets', 'needle', 'needle3.cact'), '');
writeFileSync(path.join(assetRoot, 'chaining-mcp', 'assets', 'needle', 'hela-system.txt'), 'HeLa cells.\n');
test.after(() => rmSync(assetRoot, { recursive: true, force: true }));

const context = { workspaceRoot: '/tmp/ws', cwd: '/tmp/cwd' };
const envelope = (value) => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] });
const namespaced = (cell, realName, description, properties = {}, required = []) => ({
  name: `hela_${cell}_${realName}`, cell: `hela-${cell}`, realName, description,
  inputSchema: { type: 'object', properties, ...(required.length ? { required } : {}) },
});
const text = { type: 'string' };

// `pick` stands in for Needle: it sees the shortlist names and returns its choice.
function agentWith(tools, executeAgentTool, pick) {
  const host = { agentCatalog: () => tools, agentContext: () => context, executeAgentTool };
  const agent = new NativeNeedleAgent(host, { root: assetRoot, profile: null });
  agent.choose = async (shortlist) => pick(shortlist.map((tool) => tool.name));
  agent.arguments = async () => ({ args: {} });
  return agent;
}

const files = [
  namespaced('membrane', 'read_file', 'Read a file from disk.', { path: text }, ['path']),
  namespaced('membrane', 'list_directory', 'List files and folders in a directory.', { path: text }, ['path']),
  namespaced('membrane', 'write_file', 'Create or overwrite a file.', { path: text, content: text }, ['path', 'content']),
  namespaced('nucleus', 'execute_command', 'Run a shell command with bash.', { command: text, workingDirectory: text }, ['command']),
];

test('RT-09: a deterministic plan resolves bare names against a namespaced catalog', async () => {
  const task = 'Read README.md and report its first heading only.';
  const seen = [];
  const agent = agentWith(files, async (tool, args) => { seen.push([tool.name, args.path]); return envelope('# HeLa'); }, (names) => names[0]);
  const result = await agent.run({ task, maxIterations: 3, maxToolCalls: 4 });
  assert.equal(result.status, 'ok', JSON.stringify(result.decision));
  assert.equal(seen.length, 1);
  assert.equal(seen[0][0], 'hela_membrane_read_file');
  assert.match(seen[0][1], /README\.md$/);
  assert.equal(result.history[0].intent, 'read');
  assert.equal(result.decision.reason, 'plan complete');
});

test('RT-09: argument repair and write bans key on the cell tool name', async () => {
  const shell = repairArgs(files[3], { host: 'remote' }, 'Check disk usage and list large files', [], context);
  assert.match(shell.args.command, /df -h/);
  assert.equal(shell.args.host, undefined);
  const agent = agentWith(files, async () => envelope('ok'), (names) => names[0]);
  const { retrieved } = await agent.plan({ task: 'Summarise the files, do not modify any files', limit: 10 });
  assert.ok(retrieved.length);
  assert.ok(!retrieved.some((tool) => tool.name === 'hela_membrane_write_file'));
});
