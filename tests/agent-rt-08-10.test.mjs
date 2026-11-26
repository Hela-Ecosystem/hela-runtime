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
const bare = (tools) => tools.map((tool) => ({ ...tool, name: tool.realName }));
const FLAVOURS = [['bare', bare], ['namespaced', (tools) => tools]];

// `pick` stands in for Needle: it sees the shortlist names and returns its choice.
function agentWith(tools, executeAgentTool, pick, args = {}) {
  const host = { agentCatalog: () => tools, agentContext: () => context, executeAgentTool };
  const agent = new NativeNeedleAgent(host, { root: assetRoot, profile: null });
  agent.choose = async (shortlist) => pick(shortlist.map((tool) => tool.name));
  agent.arguments = async (tool) => ({ args: args[tool.realName] ?? {} });
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

for (const [flavour, shape] of FLAVOURS) {
  const tools = shape(risky);
  const exposed = (realName) => tools.find((tool) => tool.realName === realName).name;

  test(`RT-10 (${flavour}): the metadata repro never retrieves or runs a mutating tool`, async () => {
    const task = 'Inspect metadata for /tmp/opencode/definitely-missing.md';
    const seen = [];
    const agent = agentWith(tools, async (tool) => { seen.push(tool.realName); return envelope({ success: false, error: 'ENOENT' }); }, () => exposed('opencode_session_delete'));
    const planned = await agent.plan({ task, limit: 50 });
    assert.ok(planned.retrieved.some((tool) => tool.name === exposed('get_file_info')));
    assert.deepEqual(writes(names(task, tools)), []);
    const result = await agent.run({ task, maxIterations: 6, maxToolCalls: 6 });
    assert.deepEqual(writes(seen), []);
    assert.ok(!result.catalog.retrieved.some((name) => mutating.some((entry) => name === exposed(entry.realName))), JSON.stringify(result.catalog.retrieved));
  });

  test(`RT-10 (${flavour}): path and URL segments do not score tools`, () => {
    for (const task of ['Inspect metadata for /tmp/opencode/x.md', 'Inspect metadata for "/tmp/my opencode/x.md".', 'Inspect metadata for https://example.com/opencode/session', 'Inspect metadata for src/opencode/session']) {
      assert.deepEqual(names(task, shape([mutating[0]])), [], task);
      assert.ok(!names(task, tools).includes('opencode_session_delete'), task);
    }
  });

  test(`RT-10 (${flavour}): paths, quotes and negations do not unlock an action`, () => {
    for (const task of [
      'Inspect metadata for /tmp/delete-me/remove.md',
      'Inspect files that mention "delete the opencode session"',
      "Inspect the opencode session metadata, don't close or stop it",
    ]) assert.deepEqual(writes(names(task, tools)), [], task);
  });
}

for (const [flavour, shape] of FLAVOURS) {
  test(`RT-10 (${flavour}): a task that asks for a change keeps the tools that perform it`, () => {
    const tools = shape(risky);
    assert.ok(names('Delete the opencode session abc123', tools).includes('opencode_session_delete'));
    assert.ok(names('Uninstall the app and its files', tools).includes('app_uninstall'));
    assert.ok(names('Stop the app and inspect metadata', tools).includes('app_stop'));
    assert.ok(names('Move the metadata file /tmp/a.md to /tmp/b.md', tools).includes('move_file'));
    assert.ok(names('Search archive metadata', tools).includes('archive_org_search'));
  });
}

for (const [flavour, shape] of FLAVOURS) {
  test(`RT-10 (${flavour}): verbs inside a path do not plan a shell or write step`, async () => {
    const agent = agentWith(shape(files), async () => envelope('notes'), (list) => list[0]);
    for (const task of ['Read /srv/build/test/notes.md', 'Read /home/user/save/notes.md']) {
      assert.deepEqual((await agent.plan({ task })).plan.map((step) => step.tool), ['read_file'], task);
    }
  });
}

for (const [flavour, shape] of FLAVOURS) {
  test(`RT-10 (${flavour}): a memory lookup plans neither a write nor a web search; a memory write still plans`, async () => {
    const agent = agentWith(shape(files), async () => envelope('ok'), (list) => list[0]);
    const plan = async (task) => (await agent.plan({ task })).plan.map((step) => step.tool);
    assert.deepEqual(await plan('Search the knowledge graph for release notes'), []);
    assert.deepEqual(await plan('Remember that releases ship on Friday'), ['memory_edit']);
    assert.deepEqual(await plan('Add an observation: the build is green'), ['memory_edit']);
  });
}

test('RT-10: a long slash-free word does not stall path matching', () => {
  const started = Date.now();
  names(`Inspect ${'a'.repeat(200000)}`);
  assert.ok(Date.now() - started < 5000);
});

test('RT-10: unclosed quotes and punctuation runs do not stall the gate', () => {
  for (const task of [`delete ${' "x'.repeat(60000)}`, `delete ${'.'.repeat(60000)}a/`]) {
    const started = Date.now();
    names(task);
    assert.ok(Date.now() - started < 5000, task.slice(0, 20));
  }
});

for (const [flavour, shape] of FLAVOURS) {
  test(`RT-10 (${flavour}): an unclosed quote hides nothing, a closed one only its own span`, () => {
    assert.ok(names('Please "inspect, then delete the opencode session', shape(risky)).includes('opencode_session_delete'));
    assert.ok(names('Inspect "the notes" then delete the opencode session', shape(risky)).includes('opencode_session_delete'));
    assert.ok(!names("Inspect the opencode session named 'delete me'.", shape(risky)).includes('opencode_session_delete'));
  });
}

for (const [flavour, shape] of FLAVOURS) {
  test(`RT-10 (${flavour}): a bare filename is data, not an action`, async () => {
    const tools = shape(risky);
    for (const task of ['Inspect metadata for delete.md.', 'Inspect metadata for remove.log and stop.json', 'Inspect metadata for "kill.sh"']) {
      assert.deepEqual(writes(names(task, tools)), [], task);
    }
    const seen = [];
    const choice = shape([mutating[0]])[0].name;
    const agent = agentWith(tools, async (tool) => { seen.push(tool.realName); return envelope('delete.md metadata'); }, () => choice);
    await agent.run({ task: 'Inspect metadata for delete.md.', maxIterations: 4, maxToolCalls: 4 });
    assert.deepEqual(writes(seen), []);
  });
}

// hela-runtime#4: get_current_time is retrieved, yet Needle opens with watch_file.
const clock = [
  namespaced('membrane', 'watch_file', 'Watch file or directory for changes.', { path: text }),
  namespaced('membrane', 'read_file', 'Read a file from disk.', { path: text }),
  namespaced('mitosis', 'convert_time', 'Convert time between timezones', { source_timezone: text, time: text, target_timezone: text }, ['source_timezone', 'time', 'target_timezone']),
  namespaced('mitosis', 'get_current_time', 'Get current time in a specific timezone', { timezone: text }, ['timezone']),
  namespaced('receptor', 'app_current', 'Get the app currently in the foreground.', {}),
];
const CLOCK_ARGS = {
  get_current_time: { timezone: 'Asia/Jakarta' },
  convert_time: { source_timezone: 'UTC', time: '12:00', target_timezone: 'Asia/Jakarta' },
  watch_file: { path: '/data/x' },
};
const NOW = envelope({ timezone: 'Asia/Jakarta', datetime: '2026-11-25T21:30:00+07:00' });

for (const [flavour, shape] of FLAVOURS) {
  const tools = shape(clock);
  const exposed = (realName) => tools.find((tool) => tool.realName === realName)?.name;
  const start = async (task, choice, outcome = () => NOW) => {
    const seen = [];
    const agent = agentWith(tools, async (tool) => { seen.push(tool.realName); return outcome(tool.realName); }, () => (choice === 'done' ? choice : exposed(choice)), CLOCK_ARGS);
    const result = await agent.run({ task, maxIterations: 4, maxToolCalls: 3 });
    return { seen, result };
  };

  for (const task of ['Tell me the current time in Asia/Jakarta', 'Tell me the current time in Asia/Jakarta. Do not modify any files.']) {
    for (const choice of ['watch_file', 'done', undefined]) {
      test(`RT-08 (${flavour}): get_current_time is tried first when Needle answers ${choice}: ${task}`, async () => {
        const { seen, result } = await start(task, choice);
        assert.deepEqual(seen, ['get_current_time'], JSON.stringify(result.notes));
        assert.equal(result.status, 'ok');
        assert.equal(result.decision.reason, `single action complete (${exposed('get_current_time')})`);
      });
    }
  }

  test(`RT-08 (${flavour}): a pick that shares a task word is respected`, async () => {
    for (const task of ['Compare the current time in UTC and Asia/Jakarta', 'Tell me the current time in Asia/Jakarta']) {
      const { seen, result } = await start(task, 'convert_time');
      assert.deepEqual(seen, ['convert_time'], task);
      assert.deepEqual(result.notes, []);
    }
  });

  test(`RT-08 (${flavour}): the preference only opens the run, so Needle can move on after a failure`, async () => {
    const { seen, result } = await start('Tell me the current time in Asia/Jakarta. Do not modify any files.', 'watch_file',
      (name) => (name === 'watch_file' ? NOW : envelope({ success: false, error: 'bad timezone' })));
    assert.deepEqual(seen, ['get_current_time', 'watch_file']);
    assert.equal(result.status, 'degraded');
  });

  const files08 = shape([
    namespaced('membrane', 'delete_file', 'Delete a file.', { path: text }),
    namespaced('membrane', 'get_file_info', 'Get file metadata.', { path: text }),
    namespaced('membrane', 'write_file', 'Create a file, or delete its content.', { path: text }),
  ]);
  const change = async (...picks) => {
    const seen = [];
    const agent = agentWith(files08, async (tool) => { seen.push(tool.realName); return envelope('stale file'); },
      (list) => list.find((name) => picks.some((pick) => name.endsWith(pick) && !seen.includes(pick))) ?? 'done');
    const result = await agent.run({ task: 'Delete the stale file', maxIterations: 4, maxToolCalls: 3 });
    return { seen, result };
  };

  test(`RT-08 (${flavour}): reading, or another change, does not complete a requested deletion`, async () => {
    for (const pick of ['get_file_info', 'write_file']) {
      const { seen, result } = await change(pick);
      assert.deepEqual(seen, [pick]);
      assert.equal(result.ok, false);
      assert.equal(result.status, 'failed');
      assert.match(result.decision.reason, /requested change not made/);
    }
  });

  test(`RT-08 (${flavour}): a deletion after a lookup completes the task`, async () => {
    const seen = [];
    const agent = agentWith(files08, async (tool) => { seen.push(tool.realName); return envelope('stale file'); },
      (list) => list.find((name) => name.endsWith(seen.length ? 'delete_file' : 'get_file_info')));
    const result = await agent.run({ task: 'Delete the stale file', maxIterations: 4, maxToolCalls: 3 });
    assert.deepEqual(seen, ['get_file_info', 'delete_file']);
    assert.equal(result.status, 'ok');
  });

  for (const choice of ['session_signal', undefined, 'done']) {
    test(`RT-08 (${flavour}): a task asking for a change is never swapped for a read-only name match (${choice})`, async () => {
      const server = shape([
        namespaced('ribosome', 'session_signal', 'Kill or signal a session process.', {}),
        namespaced('ribosome', 'opencode_status', 'Show opencode server status.', {}),
      ]);
      const seen = [];
      const agent = agentWith(server, async (tool) => { seen.push(tool.realName); return envelope('opencode server'); },
        (list) => (choice === 'done' ? choice : list.find((name) => name.endsWith(choice))));
      const result = await agent.run({ task: 'Kill the opencode server', maxIterations: 1 });
      assert.ok(!result.notes.some((note) => /matches the task/.test(note)), JSON.stringify(result.notes));
      if (choice === 'session_signal') assert.deepEqual(seen, ['session_signal']);
      if (choice === 'done') assert.deepEqual(seen, []);
    });
  }

  test(`RT-08 (${flavour}): a single shared word does not make a tool the opening`, async () => {
    const lookups = shape([
      namespaced('enzyme', 'url_metadata_extractor', 'Extract metadata from a URL.', {}),
      namespaced('membrane', 'read_file', 'Read a file from disk.', {}),
    ]);
    const seen = [];
    const agent = agentWith(lookups, async (tool) => { seen.push(tool.realName); return envelope('metadata'); }, (list) => list.find((name) => name.endsWith('read_file')));
    await agent.run({ task: 'Inspect metadata for /tmp/opencode/definitely-missing.md', maxIterations: 1 });
    assert.deepEqual(seen, ['read_file']);
  });
}

for (const [flavour, shape] of FLAVOURS) {
  test(`RT-08 (${flavour}): a change made by a tool without a change verb in its name completes the task`, async () => {
    const tools = shape([namespaced('genome', 'cache', 'Get, set or clear cache entries.', {}), namespaced('genome', 'read_graph', 'Read the cache graph.', {})]);
    const seen = [];
    const agent = agentWith(tools, async (tool) => { seen.push(tool.realName); return envelope('cache cleared'); }, (list) => list.find((name) => name.endsWith('cache')));
    const result = await agent.run({ task: 'Clear the cache', maxIterations: 4, maxToolCalls: 3 });
    assert.deepEqual(seen, ['cache']);
    assert.equal(result.status, 'ok', JSON.stringify(result.decision));
  });
}
