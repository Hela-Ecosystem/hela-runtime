// hela-runtime#4 / hela-mcp-ecosystem#8: a tool that returns a failure payload is a failed step.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { NativeNeedleAgent, avoidMutatingTools, retrieveTools } from '../dist/agent.js';
import { classifyToolResult } from '../dist/outcome.js';

const assetRoot = mkdtempSync(path.join(os.tmpdir(), 'hela-agent-failed-'));
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
  tool('get_current_time', 'Get the current time in a timezone.', { timezone: { type: 'string' } }, ['timezone']),
];
const envelope = (value, isError) => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }], ...(isError ? { isError: true } : {}) });
const EISDIR = envelope({ success: false, message: 'Failed to read file: EISDIR: illegal operation on a directory' });

// The live repro from runtime#4. Needle is stubbed: the loop, not the model, is under test.
const TASK = 'Tell me the current time in Asia/Jakarta. Do not modify any files.';
// A clock whose name shares no word with TASK, so the loop follows the stubbed picks instead of
// opening with a name match (RT-08).
const unnamedClock = catalog.map((entry) => (entry.name === 'get_current_time' ? tool('clock_now', entry.description) : entry));
function agentWith(executeAgentTool, picks, tools = catalog) {
  const host = { agentCatalog: () => tools, agentContext: () => ({ workspaceRoot: '/tmp/ws', cwd: '/tmp/cwd' }), executeAgentTool };
  const agent = new NativeNeedleAgent(host, { root: assetRoot, profile: null });
  const queue = [...picks];
  agent.choose = async () => (queue.length > 1 ? queue.shift() : queue[0]);
  agent.arguments = async (selected) => ({ args: selected.name === 'get_current_time' ? { timezone: 'Asia/Jakarta' } : { path: '/data/some-directory' } });
  return agent;
}

test('classifyToolResult: failure is read from the payload, not from whether the call threw', () => {
  assert.equal(classifyToolResult(envelope('plain text answer')).ok, true);
  assert.equal(classifyToolResult(envelope({ success: true, data: 1 })).ok, true);
  const noSuchFile = classifyToolResult(envelope({ success: false, message: 'ENOENT', error: 'ENOENT: no such file' }));
  assert.equal(noSuchFile.ok, false);
  assert.equal(noSuchFile.error, 'ENOENT: no such file');
  assert.equal(classifyToolResult(envelope({ ok: false, error: 'bad input' })).ok, false);
  assert.equal(classifyToolResult(envelope('Tool blew up', true)).ok, false);
  assert.equal(classifyToolResult({ ok: false, error: 'runtime-hosted tool failed' }).ok, false); // plain object, no MCP envelope
  assert.equal(classifyToolResult({ ok: true, tool: 'x' }).ok, true);
  const degraded = classifyToolResult(envelope({ ok: true, status: 'degraded', warnings: ['truncated at 5 MB'] }));
  assert.equal(degraded.ok, true);
  assert.deepEqual(degraded.degraded, ['status=degraded', 'truncated at 5 MB']);
  assert.doesNotThrow(() => classifyToolResult(undefined));
  assert.doesNotThrow(() => classifyToolResult(null));
});

test('classifyToolResult: structured payloads and isError work without text content', () => {
  const structuredContent = { ok: false, error: 'boom' };
  const failed = classifyToolResult({ structuredContent, isError: true });
  assert.equal(failed.ok, false);
  assert.equal(failed.payload, structuredContent);
  assert.equal(failed.error, 'boom');
  assert.equal(classifyToolResult({ structuredContent }).ok, false);
  assert.equal(classifyToolResult({ isError: true }).ok, false);
});

test('classifyToolResult: structured degradation takes precedence over a text summary', () => {
  const structuredContent = { ok: true, partial: true, truncated: true, warnings: ['missing rows'] };
  const outcome = classifyToolResult({ ...envelope('Found some rows'), structuredContent });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.payload, structuredContent);
  assert.deepEqual(outcome.degraded, ['partial', 'truncated', 'missing rows']);
});

test('agent_run: a read with a task-wide edit prohibition executes only read_file', async () => {
  const seen = [];
  const agent = agentWith(async (selected) => {
    seen.push(selected.name);
    return envelope('notes');
  }, ['write_file']);
  const task = 'Read notes.txt. Do not edit any files.';
  const result = await agent.run({ task });
  assert.deepEqual(seen, ['read_file']);
  assert.equal(result.ok, true);
  assert.deepEqual(result.plan.map((step) => step.tool), ['read_file']);
});

test('agent_run: a stubbed write choice cannot override a task-wide prohibition', async () => {
  const seen = [];
  const onlyWrites = catalog.filter((entry) => entry.name === 'write_file');
  const agent = agentWith(async (selected) => {
    seen.push(selected.name);
    return envelope({ ok: true });
  }, ['write_file'], onlyWrites);
  const result = await agent.run({ task: TASK });
  assert.deepEqual(seen, []);
  assert.equal(result.ok, false);
  assert.equal(result.toolCalls, 0);
  assert.match(result.decision.reason, /no (?:permitted|safe) tool/i);
});

test('agent_plan: an ordinary write still plans write_file', async () => {
  const agent = agentWith(async () => assert.fail('plan should never execute tools'), []);
  const result = await agent.plan({ task: 'Write hello to notes.txt' });
  assert.deepEqual(result.plan.map((step) => step.tool), ['write_file']);
});

test('agent_run: a failed payload is a failed run, not "single action complete"', async () => {
  const agent = agentWith(async () => EISDIR, ['read_file'], unnamedClock);
  const result = await agent.run({ task: TASK, maxIterations: 4, maxToolCalls: 3 });
  assert.equal(result.ok, false);
  assert.equal(result.status, 'failed');
  assert.equal(result.history[0].ok, false);
  assert.match(result.history[0].error, /EISDIR/);
  assert.doesNotMatch(result.decision.reason, /single action complete/);
  assert.match(result.decision.reason, /repeated failing call skipped/);
  assert.equal(result.toolCalls, 1, 'the identical failing call is not run again');
  assert.equal(result.decision.action, 'failed');
});

test('agent_run: recovers when a later call succeeds, and says some calls failed', async () => {
  const seen = [];
  const agent = agentWith(async (selected) => {
    seen.push(selected.name);
    return selected.name === 'read_file' ? EISDIR : envelope({ timezone: 'Asia/Jakarta', datetime: '2026-11-25T04:30:00+07:00' });
  }, ['read_file', 'clock_now'], unnamedClock);
  const result = await agent.run({ task: TASK, maxIterations: 4, maxToolCalls: 3 });
  assert.deepEqual(seen, ['read_file', 'clock_now']);
  assert.equal(result.ok, true);
  assert.equal(result.status, 'degraded');
  assert.equal(result.failedCalls, 1);
  assert.match(result.decision.reason, /single action complete \(clock_now\)/);
});

test('agent_run: a clean success is unchanged', async () => {
  const agent = agentWith(async () => envelope({ timezone: 'Asia/Jakarta' }), ['get_current_time']);
  const result = await agent.run({ task: TASK, maxIterations: 4, maxToolCalls: 3 });
  assert.equal(result.ok, true);
  assert.equal(result.status, 'ok');
  assert.equal(result.failedCalls, undefined);
  assert.equal(result.toolCalls, 1);
});

test('agent_run: a thrown error is also a failed run, and is not retried verbatim', async () => {
  let calls = 0;
  const agent = agentWith(async () => { calls++; throw new Error('cell crashed'); }, ['get_current_time']);
  const result = await agent.run({ task: TASK, maxIterations: 5, maxToolCalls: 5 });
  assert.equal(result.ok, false);
  assert.equal(result.status, 'failed');
  assert.equal(calls, 1);
  assert.match(result.history[0].error, /cell crashed/);
});

test('agent_run: partial results are reported as degraded', async () => {
  const agent = agentWith(async () => envelope({ ok: true, partial: true, timezone: 'Asia/Jakarta' }), ['get_current_time']);
  const result = await agent.run({ task: TASK, maxIterations: 3, maxToolCalls: 3 });
  assert.equal(result.ok, true);
  assert.equal(result.status, 'degraded');
  assert.deepEqual(result.degraded, ['partial']);
});

test('retrieval keeps write tools out of the shortlist when the task forbids modification', () => {
  const forbids = [
    'Tell me the current time in Asia/Jakarta. Do not modify any files.',
    "Read notes.txt, don't change anything",
    'Summarise the repo and never overwrite existing files',
    'List the directory without writing to disk',
  ];
  for (const task of forbids) {
    const names = retrieveTools(catalog, task).map((t) => t.name);
    assert.ok(!names.includes('write_file'), `write_file offered for: ${task}`);
    assert.ok(names.length > 0);
  }
  // Ordinary tasks, and tasks that merely contain "no" or "save", keep every tool.
  for (const task of ['Write hello to notes.txt', 'I have no idea how to save time on this', 'Create a file named a.txt']) {
    assert.ok(retrieveTools(catalog, task, [], 10).map((t) => t.name).includes('write_file'), task);
  }
  // Never an empty shortlist: if only mutating tools exist they stay.
  const onlyWrites = catalog.filter((t) => t.name === 'write_file');
  assert.deepEqual(avoidMutatingTools(onlyWrites, 'Do not modify any files').map((t) => t.name), ['write_file']);
});
