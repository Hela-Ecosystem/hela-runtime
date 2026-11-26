// Review of 38e13fa: one permission gate for write-banned and read-only tasks. Every case runs against a bare and a
// namespaced catalog. Needle is stubbed to make the worst choice: the gate, not the model, is under test.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { NativeNeedleAgent, retrieveTools } from '../dist/agent.js';

const assetRoot = mkdtempSync(path.join(os.tmpdir(), 'hela-agent-gate-'));
mkdirSync(path.join(assetRoot, 'chaining-mcp', 'assets', 'needle'), { recursive: true });
writeFileSync(path.join(assetRoot, 'chaining-mcp', 'assets', 'needle', 'needle3'), '');
writeFileSync(path.join(assetRoot, 'chaining-mcp', 'assets', 'needle', 'needle3.cact'), '');
writeFileSync(path.join(assetRoot, 'chaining-mcp', 'assets', 'needle', 'hela-system.txt'), 'HeLa cells.\n');
test.after(() => rmSync(assetRoot, { recursive: true, force: true }));

const context = { workspaceRoot: '/tmp/ws', cwd: '/tmp/cwd' };
const envelope = (value) => ({ content: [{ type: 'text', text: value }] });
const FLAVOURS = ['bare', 'namespaced'];
const text = { type: 'string' };
const catalogOf = (flavour, specs) => specs.map(([realName, description, properties = {}, required = [], annotations]) => ({
  name: flavour === 'bare' ? realName : `hela_fixture_${realName}`, cell: 'hela-fixture', realName, description,
  inputSchema: { type: 'object', properties, ...(required.length ? { required } : {}) }, ...(annotations ? { annotations } : {}),
}));

// Needle picks `want` whenever it is offered, and answers with it even when it is not.
async function run(tools, task, want, args = {}) {
  const calls = [];
  const offered = new Set();
  const agent = new NativeNeedleAgent({
    agentCatalog: () => tools, agentContext: () => context,
    executeAgentTool: async (tool, repaired) => { calls.push({ tool: tool.realName, args: repaired }); return envelope('settings files command'); },
  }, { root: assetRoot, profile: null });
  agent.choose = async (shortlist) => {
    for (const tool of shortlist) offered.add(tool.realName);
    return shortlist.find((tool) => tool.realName === want)?.name ?? tools.find((tool) => tool.realName === want)?.name;
  };
  agent.arguments = async (tool) => ({ args: args[tool.realName] ?? {} });
  const result = await agent.run({ task, maxIterations: 5, maxToolCalls: 5 });
  const { plan } = await agent.plan({ task });
  return { result, calls, ran: calls.map((call) => call.tool), offered: [...offered], plan: plan.map((step) => step.tool) };
}

const SIDE_EFFECTS = [
  'execute_command', 'shell_exec', 'session_spawn', 'session_write', 'transfer_file', 'execute_sql',
  'execute_blender_code', 'agent_spawn', 'browser_evaluate', 'browser_check', 'data_export', 'some_future_tool',
];
const dangerous = [
  ...SIDE_EFFECTS.map((name) => [name, `Inspect repository configuration settings files command with ${name}.`, { command: text }]),
  ['read_file', 'Read a configuration file.', { path: text }],
];

for (const flavour of FLAVOURS) {
  const tools = catalogOf(flavour, dangerous);
  for (const task of [
    'Inspect the repository configuration. Do not modify any files.',
    'Inspect the repository configuration settings.',
    'Tell me which command settings files exist',
  ]) {
    for (const want of SIDE_EFFECTS) {
      test(`gate (${flavour}): ${want} is never offered, planned or run for: ${task}`, async () => {
        const { ran, offered, plan } = await run(tools, task, want, { [want]: { command: 'touch /tmp/never' } });
        for (const list of [ran, offered, plan, retrieveTools(tools, task, [], 50).map((tool) => tool.realName)]) {
          assert.deepEqual(list.filter((name) => SIDE_EFFECTS.includes(name)), []);
        }
      });
    }
  }

  test(`gate (${flavour}): cell hints decide before the allow-list`, () => {
    const hinted = catalogOf(flavour, [
      ['peek_settings', 'Inspect settings.', {}, [], { readOnlyHint: true }],
      ['poke_settings', 'Inspect settings.', {}, [], { readOnlyHint: false }],
      ['read_file', 'Inspect settings.', {}, [], { destructiveHint: true }],
      ['delete_settings', 'Inspect settings.', {}, [], { readOnlyHint: true }],
      ['list_directory', 'Inspect settings.'],
    ]);
    assert.deepEqual(retrieveTools(hinted, 'Inspect the settings', [], 10).map((tool) => tool.realName).sort(), ['list_directory', 'peek_settings']);
  });

  const shell = catalogOf(flavour, [['execute_command', 'Run a shell command.', { command: text, env: { type: 'object' }, useRtk: { type: 'boolean' } }, ['command']]]);
  const sabotage = { execute_command: { command: 'touch /tmp/never', env: { GIT_EXTERNAL_DIFF: '/tmp/x' }, useRtk: false } };

  test(`gate (${flavour}): a read-only diagnostic runs the runtime's command and nothing from the model`, async () => {
    for (const task of ['Check disk usage and list large files', 'Show the git status', 'Tell me about `touch /tmp/never` and disk usage']) {
      const { calls } = await run(shell, task, 'execute_command', sabotage);
      for (const call of calls) {
        assert.doesNotMatch(call.args.command, /touch/, task);
        assert.deepEqual(Object.keys(call.args).sort(), ['command', 'workingDirectory'], task);
      }
      assert.equal(calls.length, task.includes('`') ? 0 : 1, task);
    }
  });

  test(`gate (${flavour}): a write ban closes the shell even for diagnostics`, async () => {
    const { ran, plan, result } = await run(shell, 'Check disk usage. Do not modify any files.', 'execute_command', sabotage);
    assert.deepEqual([ran, plan], [[], []]);
    assert.equal(result.status, 'failed');
  });

  test(`gate (${flavour}): the final arguments are checked at dispatch`, async () => {
    const browser = catalogOf(flavour, [['browser_navigate', 'Open a URL.', { url: text }, ['url']]]);
    const task = 'Open the settings page. Do not modify any files.';
    const { ran, result } = await run(browser, task, 'browser_navigate', { browser_navigate: { url: 'javascript:document.body.remove()' } });
    assert.deepEqual(ran, []);
    assert.match(result.decision.reason, /permission gate/);
  });

  test(`gate (${flavour}): an unrecognised change verb is not treated as read-only`, async () => {
    const dirs = catalogOf(flavour, [['create_directory', 'Create a directory.', { path: text }, ['path']]]);
    for (const task of ['Provision a directory at /tmp/output', 'Set up a directory at /tmp/output', 'Scaffold a directory at /tmp/output']) {
      const { ran } = await run(dirs, task, 'create_directory', { create_directory: { path: '/tmp/output' } });
      assert.deepEqual(ran.slice(0, 1), ['create_directory'], task);
    }
  });

  const page = catalogOf(flavour, [
    ['browser_navigate', 'Open a URL in the browser page.', { url: text }, ['url']],
    ['browser_get_state', 'Inspect the current page settings.'],
    ['browser_click', 'Click an element on the page. Delete settings.', { selector: text }],
    ['browser_type', 'Type into a form on the page.', { text }],
    ['browser_press', 'Press a key on the page to submit.', { key: text }],
    ['browser_screenshot', 'Take a screenshot of the page.'],
    ['delete_file', 'Delete a settings file on the page.', { path: text }],
  ]);
  const BANNED_BY = { browser_click: /click/i, browser_type: /typ/i, browser_press: /press|submit|click/i, delete_file: /delet|modify/i };
  const ACTIONS = Object.keys(BANNED_BY);

  for (const task of [
    'Open https://example.test/settings and inspect the page. Do not click Delete. Do not modify any files.',
    'Open https://example.test/settings and inspect the page. Do not click Delete.',
    'Open https://example.test/settings and take a screenshot. Do not click, type, submit or delete anything.',
    'Open https://example.test/settings and take a screenshot without clicking, typing, or submitting anything',
    "Open https://example.test/settings. Don't click or type, and never press Enter.",
    'Open https://example.test/settings. You should not, under any circumstances, delete or click anything.',
  ]) {
    for (const want of ACTIONS.filter((name) => BANNED_BY[name].test(task))) {
      test(`gate (${flavour}): a banned ${want} is neither planned nor run: ${task}`, async () => {
        const { ran, plan } = await run(page, task, want, { browser_navigate: { url: 'https://example.test/settings' } });
        assert.ok(!plan.includes(want), `planned: ${plan}`);
        assert.ok(!ran.includes(want), `ran: ${ran}`);
        assert.equal(ran[0], 'browser_navigate');
      });
    }
  }

  test(`gate (${flavour}): typed apostrophes and "no clicking" are bans too`, async () => {
    for (const task of ['Open https://example.test/a. No clicking.', 'Open https://example.test/a. Don\u2019t click anything.', 'Open https://example.test/a. Don\u2019t modify anything, then click Next']) {
      const { ran, plan } = await run(page, task, 'browser_click', { browser_navigate: { url: 'https://example.test/a' } });
      assert.ok(!plan.includes('browser_click') && !ran.includes('browser_click'), task);
    }
  });

  test(`gate (${flavour}): politely worded lookups are read-only`, async () => {
    for (const task of ['Hey, inspect the settings', 'I want to know the settings', 'Okay, could you please check the settings']) {
      assert.deepEqual(retrieveTools(tools, task, [], 50).map((tool) => tool.realName).filter((name) => SIDE_EFFECTS.includes(name)), [], task);
    }
  });

  test(`gate (${flavour}): protecting the input exempts only that phrase, not the other bans beside it`, async () => {
    const mixed = catalogOf(flavour, [
      ['browser_navigate', 'Open a URL in the browser page.', { url: text }, ['url']],
      ['browser_click', 'Click an element on the settings page.'],
      ['copy_file', 'Copy a settings file.', { source: text }],
      ['write_file', 'Write a settings file.', { path: text }],
      ['delete_file', 'Delete a settings file.', { path: text }],
      ['execute_command', 'Run a shell command on the settings.', { command: text }],
    ]);
    const offered = (task) => retrieveTools(mixed, task, [], 10).map((tool) => tool.realName);
    const open = 'Open https://example.test/settings. Do not modify the original or click anything.';
    const { ran, plan } = await run(mixed, open, 'browser_click', { browser_navigate: { url: 'https://example.test/settings' } });
    assert.ok(!plan.includes('browser_click') && !ran.includes('browser_click'), `${plan} / ${ran}`);
    assert.ok(!offered(open).includes('browser_click'));
    for (const [task, refused] of [
      ['Copy the settings file without modifying the original or deleting anything', ['delete_file', 'execute_command']],
      ['Copy the settings file without modifying the original or running anything', ['execute_command']],
      ['Copy the settings file without modifying the original, or clicking', ['browser_click']],
      ['Copy the settings file. Do not modify the original or write anything', ['write_file', 'execute_command']],
    ]) {
      assert.deepEqual((await run(mixed, task, 'copy_file')).plan.filter((name) => refused.includes(name)), [], task);
      assert.ok(offered(task).includes('copy_file'), task);
      assert.deepEqual(offered(task).filter((name) => refused.includes(name)), [], task);
    }
    for (const task of [
      'Copy the settings file without modifying the original', 'Copy the settings file without changing the source data',
      'Copy the settings file. Do not modify the original or the copy', 'Copy the settings file without changing the source, or its backup copy',
    ]) {
      assert.deepEqual((await run(mixed, task, 'copy_file')).plan, ['copy_file'], task);
      assert.deepEqual(offered(task).sort(), ['browser_click', 'copy_file', 'delete_file', 'execute_command', 'write_file'], task);
    }
  });

  test(`gate (${flavour}): a ban on any change closes the shell; a page-action ban does not`, async () => {
    const tools = catalogOf(flavour, [['execute_command', 'Run a shell command to check disk usage and fix the build.', { command: text }, ['command']]]);
    const args = { execute_command: { command: 'make fix' } };
    for (const ban of ['install anything', 'stop the server', 'move files', 'copy anything', 'upload anything', 'import data', 'archive logs', 'extract anything', 'delete anything', 'run anything']) {
      for (const task of [`Fix the build. Do not ${ban}.`, `Check disk usage. Do not ${ban}.`]) {
        const { ran, offered, plan } = await run(tools, task, 'execute_command', args);
        assert.deepEqual([ran, offered, plan], [[], [], []], task);
      }
    }
    for (const ban of ['click anything', 'type anything', 'navigate anywhere', 'take a screenshot']) {
      for (const task of [`Fix the build. Do not ${ban}.`, `Check disk usage. Do not ${ban}.`]) {
        assert.equal((await run(tools, task, 'execute_command', args)).ran[0], 'execute_command', task);
      }
    }
  });

  test(`gate (${flavour}): long verb lists in a ban stay fast`, () => {
    for (const task of [`do not ${'modify '.repeat(20000)}`, `without modifying ${' ,'.repeat(40000)}x`]) {
      const started = Date.now();
      retrieveTools(page, task);
      assert.ok(Date.now() - started < 5000, task.slice(0, 30));
    }
  });

  test(`gate (${flavour}): a comma or semicolon glued to a path still separates clauses`, async () => {
    const planOf = async (task) => (await run(page, task, 'browser_navigate')).plan;
    for (const separator of [',', ';']) {
      assert.deepEqual(await planOf(`Open https://example.test/a and compare /tmp/report.txt${separator}screenshot`), ['browser_navigate', 'browser_screenshot'], separator);
    }
    const offered = (task) => retrieveTools(page, task, [], 20).map((tool) => tool.realName);
    // The request after the path is read: this task asks for a deletion, so it is not read-only.
    assert.ok(offered('Inspect /tmp/settings/report.txt,delete the settings page file').includes('delete_file'));
    // The path itself still names nothing.
    assert.ok(!offered('Inspect the settings page in /tmp/delete,click/report.txt').includes('delete_file'));
  });

  test(`gate (${flavour}): a URL stays whole, so its tail is never an instruction`, () => {
    for (const task of ['Inspect the settings page https://example.test/a,delete', 'Inspect the settings page https://example.test/a;delete?x=1,click', 'Inspect the settings page "/tmp/a b,delete the file"']) {
      assert.deepEqual(retrieveTools(page, task, [], 20).map((tool) => tool.realName).filter((name) => ACTIONS.includes(name)), [], task);
    }
  });

  test(`gate (${flavour}): long separator runs in a path stay fast`, () => {
    for (const task of [`inspect ${'/a,'.repeat(100000)}`, `inspect a/${',;'.repeat(100000)}b`]) {
      const started = Date.now();
      retrieveTools(page, task);
      assert.ok(Date.now() - started < 5000, task.slice(0, 30));
    }
  });

  test(`gate (${flavour}): the plan is gated on the catalog's own hints, and run() follows the same plan`, async () => {
    const hinted = catalogOf(flavour, [
      ['browser_navigate', 'Open a URL in the browser page.', { url: text }, ['url']],
      ['browser_screenshot', 'Take a screenshot of the page.', {}, [], { destructiveHint: true }],
      ['browser_type', 'Type into the page.', { text }, [], { readOnlyHint: true }],
      ['browser_press', 'Press a key.', { key: text }],
      ['browser_get_state', 'Inspect the page.'],
      ['execute_command', 'Run a shell command.', { command: text }, ['command'], 'unreadable'],
      ['read_file', 'Read a file.', { path: text }],
    ]);
    const expected = [
      ['Open https://example.test/a and take a screenshot. Do not modify any files.', ['browser_navigate']],
      // browser_type is not on the allow-list: only its published hint admits it.
      ['Open https://example.test/a and search for cells. Do not modify any files.', ['browser_navigate', 'browser_type']],
      ['Open https://example.test/a and take a screenshot', ['browser_navigate', 'browser_screenshot']],
      ['Check disk usage', []],
      ['Read notes.txt', ['read_file']],
    ];
    for (const [task, tools] of expected) {
      const agent = new NativeNeedleAgent({ agentCatalog: () => hinted, agentContext: () => context, executeAgentTool: async () => envelope('ok') }, { root: assetRoot, profile: null });
      agent.choose = async (shortlist) => shortlist[0].name;
      agent.arguments = async () => ({ args: {} });
      const planned = (await agent.plan({ task })).plan;
      assert.deepEqual(planned.map((step) => step.tool), tools, task);
      assert.deepEqual((await agent.run({ task, maxIterations: 4 })).plan, planned, task);
    }
  });

  test(`gate (${flavour}): a ban ends where the next request begins`, async () => {
    const planOf = async (task) => (await run(page, task, 'browser_navigate')).plan;
    assert.deepEqual(await planOf('Open https://example.test/a. Do not click Delete and take a screenshot'), ['browser_navigate', 'browser_screenshot']);
    assert.deepEqual(await planOf('Open https://example.test/a, do not type anything, just click Next'), ['browser_navigate', 'browser_click']);
    assert.deepEqual(await planOf('Open https://example.test/a, do not take a screenshot, and click Next'), ['browser_navigate', 'browser_click']);
  });

  test(`gate (${flavour}): many negations do not stall the gate`, () => {
    for (const task of [`inspect ${"don't ".repeat(20000)}`, `inspect do not click${', type'.repeat(20000)}`]) {
      const started = Date.now();
      retrieveTools(page, task);
      assert.ok(Date.now() - started < 5000, task.slice(0, 30));
    }
  });

  test(`gate (${flavour}): a ban naming a concrete file stays a full write ban`, async () => {
    const writers = catalogOf(flavour, [['write_file', 'Write a file.', { path: text }], ['copy_file', 'Copy a file.', { path: text }], ['read_file', 'Read a file.', { path: text }]]);
    for (const task of ['Summarise notes. Do not modify a.txt', 'Read /etc/hosts and do not change /tmp/a.txt', 'Show config.json without editing config.json', 'Copy a.txt to b.txt, do not change /tmp/c.txt']) {
      for (const want of ['write_file', 'copy_file']) {
        const { ran, offered, plan } = await run(writers, task, want, { [want]: { path: '/tmp/never' } });
        for (const list of [ran, offered, plan]) assert.ok(!list.includes(want), `${want}: ${task}`);
      }
    }
  });

  test(`gate (${flavour}): a question about deleting is not permission to delete`, async () => {
    const files = catalogOf(flavour, [['delete_file', 'Delete a file the app owns.', { path: text }], ['get_file_info', 'Get file metadata.', { path: text }]]);
    for (const task of ['Tell me which files the app can delete', 'Which files can I delete?', 'Inspect metadata for delete.md.']) {
      const { ran, offered } = await run(files, task, 'delete_file', { delete_file: { path: '/tmp/never' } });
      assert.ok(!ran.includes('delete_file') && !offered.includes('delete_file'), task);
    }
  });
}
