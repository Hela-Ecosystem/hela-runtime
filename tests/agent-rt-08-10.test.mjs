// RT-08 (runtime#4), RT-09 (runtime#8), RT-10 (runtime#9). Needle is stubbed: retrieval and the loop are under test.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { NativeNeedleAgent, repairArgs, retrieveTools } from '../dist/agent.js';

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

const mutating = [
  namespaced('ribosome', 'opencode_session_delete', 'Delete an opencode session (opencode session delete <sessionID>).', { sessionID: text }),
  namespaced('ribosome', 'session_close', 'Close a terminal session and inspect its metadata.', { sessionId: text }),
  namespaced('ribosome', 'session_signal', 'Send a signal to a session process.', { sessionId: text }),
  namespaced('membrane', 'delete_file', 'Delete a file or directory.', { path: text }),
  namespaced('membrane', 'move_file', 'Move or rename a file.', { path: text }),
  namespaced('membrane', 'copy_file', 'Copy a file.', { path: text }),
  namespaced('membrane', 'create_directory', 'Create a directory for files.', { path: text }),
  namespaced('membrane', 'write_file', 'Create or overwrite a file.', { path: text }),
  namespaced('membrane', 'stop_watching', 'Stop watching a file.', { path: text }),
  namespaced('receptor', 'app_uninstall', 'Uninstall an app and its files.', { packageName: text }),
  namespaced('receptor', 'app_stop', 'Stop an app; inspect missing metadata.', { packageName: text }),
  namespaced('genome', 'memory_edit', 'Edit file metadata observations in the knowledge graph.', { action: text }),
];
const readers = [
  namespaced('membrane', 'get_file_info', 'Get metadata for a file.', { path: text }),
  namespaced('genome', 'inspect_untrusted_text', 'Inspect untrusted text.', { text }),
  namespaced('enzyme', 'url_metadata_extractor', 'Extract metadata from a URL.', { url: text }),
  namespaced('enzyme', 'archive_org_search', 'Search archive.org metadata.', { query: text }),
];
const risky = [...mutating, ...readers];
const names = (task, tools = risky) => retrieveTools(tools, task, [], 50).map((tool) => tool.realName);
const writes = (list) => list.filter((name) => mutating.some((tool) => tool.realName === name));

test('RT-10: the metadata repro never retrieves or runs a mutating tool', async () => {
  const task = 'Inspect metadata for /tmp/opencode/definitely-missing.md';
  const seen = [];
  const agent = agentWith(risky, async (tool) => { seen.push(tool.realName); return envelope({ success: false, error: 'ENOENT' }); }, () => 'hela_ribosome_opencode_session_delete');
  const planned = await agent.plan({ task, limit: 50 });
  assert.ok(planned.retrieved.some((tool) => tool.name === 'hela_membrane_get_file_info'));
  assert.deepEqual(writes(names(task)), []);
  const result = await agent.run({ task, maxIterations: 6, maxToolCalls: 6 });
  assert.deepEqual(writes(seen), []);
  assert.ok(!result.catalog.retrieved.some((name) => mutating.some((tool) => tool.name === name)), JSON.stringify(result.catalog.retrieved));
});

test('RT-10: path and URL segments do not score tools', () => {
  for (const task of ['Inspect metadata for /tmp/opencode/x.md', 'Inspect metadata for "/tmp/my opencode/x.md".', 'Inspect metadata for https://example.com/opencode/session', 'Inspect metadata for src/opencode/session']) {
    assert.deepEqual(names(task, [mutating[0]]), [], task);
    assert.ok(!names(task).includes('opencode_session_delete'), task);
  }
});

test('RT-10: paths, quotes and negations do not unlock an action', () => {
  for (const task of [
    'Inspect metadata for /tmp/delete-me/remove.md',
    'Inspect files that mention "delete the opencode session"',
    "Inspect the opencode session metadata, don't close or stop it",
  ]) assert.deepEqual(writes(names(task)), [], task);
});

test('RT-10: a stated action makes only the matching mutating tools eligible', () => {
  assert.deepEqual(writes(names('Delete the opencode session abc123')).sort(), ['delete_file', 'opencode_session_delete']);
  assert.deepEqual(writes(names('Uninstall the app and its files')), ['app_uninstall']);
  assert.deepEqual(writes(names('Stop the app and inspect metadata')).sort(), ['app_stop', 'session_close', 'stop_watching']);
  assert.deepEqual(writes(names('Move the metadata file /tmp/a.md to /tmp/b.md')), ['move_file']);
  assert.ok(names('Search archive metadata').includes('archive_org_search'));
});

test('RT-10: verbs inside a path do not plan a shell or write step', async () => {
  const agent = agentWith(files, async () => envelope('notes'), (list) => list[0]);
  for (const task of ['Read /srv/build/test/notes.md', 'Read /home/user/save/notes.md']) {
    assert.deepEqual((await agent.plan({ task })).plan.map((step) => step.tool), ['read_file'], task);
  }
});

test('RT-10: a memory lookup plans neither a write nor a web search; a memory write still plans', async () => {
  const agent = agentWith(files, async () => envelope('ok'), (list) => list[0]);
  const plan = async (task) => (await agent.plan({ task })).plan.map((step) => step.tool);
  assert.deepEqual(await plan('Search the knowledge graph for release notes'), []);
  assert.deepEqual(await plan('Remember that releases ship on Friday'), ['memory_edit']);
  assert.deepEqual(await plan('Add an observation: the build is green'), ['memory_edit']);
});

test('RT-10: a long slash-free word does not stall path matching', () => {
  const started = Date.now();
  names(`Inspect ${'a'.repeat(200000)}`);
  assert.ok(Date.now() - started < 5000);
});

// hela-runtime#4: get_current_time is retrieved, yet Needle opens with watch_file.
const clock = [
  namespaced('membrane', 'watch_file', 'Watch file or directory for changes.', { path: text }),
  namespaced('membrane', 'read_file', 'Read a file from disk.', { path: text }),
  namespaced('mitosis', 'convert_time', 'Convert time between timezones', { time: text }),
  namespaced('mitosis', 'get_current_time', 'Get current time in a specific timezone', { timezone: text }),
  namespaced('receptor', 'app_current', 'Get the app currently in the foreground.', {}),
];
const NOW = envelope({ timezone: 'Asia/Jakarta', datetime: '2026-11-25T21:30:00+07:00' });

for (const task of ['Tell me the current time in Asia/Jakarta', 'Tell me the current time in Asia/Jakarta. Do not modify any files.']) {
  for (const choice of ['hela_membrane_watch_file', 'hela_mitosis_convert_time', 'done', undefined]) {
    test(`RT-08: get_current_time is tried first when Needle answers ${choice}: ${task}`, async () => {
      const seen = [];
      const agent = agentWith(clock, async (tool) => { seen.push(tool.realName); return NOW; }, () => choice);
      const result = await agent.run({ task, maxIterations: 4, maxToolCalls: 3 });
      assert.deepEqual(seen, ['get_current_time'], JSON.stringify(result.notes));
      assert.equal(result.status, 'ok');
      assert.match(result.decision.reason, /single action complete \(hela_mitosis_get_current_time\)/);
    });
  }
}

test('RT-08: the preference only opens the run, so Needle can move on after a failure', async () => {
  const seen = [];
  const agent = agentWith(clock, async (tool) => {
    seen.push(tool.realName);
    return tool.realName === 'convert_time' ? NOW : envelope({ success: false, error: 'bad timezone' });
  }, () => 'hela_mitosis_convert_time');
  const result = await agent.run({ task: 'Tell me the current time in Asia/Jakarta', maxIterations: 4, maxToolCalls: 3 });
  assert.deepEqual(seen, ['get_current_time', 'convert_time']);
  assert.equal(result.status, 'degraded');
});

test('RT-08: the preference never switches Needle to a mutating tool', async () => {
  const tools = [namespaced('membrane', 'delete_file', 'Delete a file.', {}), namespaced('membrane', 'get_file_info', 'Get metadata.', {})];
  const seen = [];
  const agent = agentWith(tools, async (tool) => { seen.push(tool.realName); return envelope('delete file done'); }, () => 'hela_membrane_get_file_info');
  const result = await agent.run({ task: 'Delete the stale file', maxIterations: 1 });
  assert.deepEqual(result.notes.filter((note) => /matches the task better/.test(note)), []);
  assert.deepEqual(seen, ['get_file_info']);
});

for (const choice of ['hela_ribosome_session_signal', undefined, 'done']) {
  test(`RT-08: a task asking for a change is never swapped for a read-only name match (${choice})`, async () => {
    const tools = [
      namespaced('ribosome', 'session_signal', 'Kill or signal a session process.', {}),
      namespaced('ribosome', 'opencode_status', 'Show opencode server status.', {}),
    ];
    const seen = [];
    const agent = agentWith(tools, async (tool) => { seen.push(tool.realName); return envelope('opencode server'); }, () => choice);
    const result = await agent.run({ task: 'Kill the opencode server', maxIterations: 1 });
    assert.ok(!result.notes.some((note) => /matches the task better/.test(note)), JSON.stringify(result.notes));
    if (choice === 'hela_ribosome_session_signal') assert.deepEqual(seen, ['session_signal']);
    if (choice === 'done') assert.deepEqual(seen, []);
  });
}

test('RT-08: a single shared word does not override Needle', async () => {
  const tools = [
    namespaced('enzyme', 'url_metadata_extractor', 'Extract metadata from a URL.', {}),
    namespaced('membrane', 'read_file', 'Read a file and its metadata.', {}),
  ];
  const seen = [];
  const agent = agentWith(tools, async (tool) => { seen.push(tool.realName); return envelope('metadata'); }, () => 'hela_membrane_read_file');
  await agent.run({ task: 'Inspect metadata for /tmp/opencode/definitely-missing.md', maxIterations: 1 });
  assert.deepEqual(seen, ['read_file']);
});
